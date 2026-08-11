import { indicators, qfqDaily, chinaTradingProgress } from "../../lib/indicators.js";
import {
  A_SHARE_PATTERNS,
  enrichRealtime,
  latestOpenDate,
  marketTradeTime,
  previousOpenDate,
  realtimeForCodes,
  realtimeMarket,
  summarizeThemeQuotes,
  topRows,
} from "../../lib/market.js";
import { n, s, sortNumeric, tushareQuery, TushareError, type Row } from "../../lib/tushare.js";
import {
  eastmoneyBoardMembers, eastmoneyBoards, eastmoneyIndices, eastmoneyMarketFullAttempt,
  eastmoneyMarketRank, eastmoneyMinutes, eastmoneyQuote, eastmoneyQuotes, quoteConsensus,
  sinaMinutes, sinaQuote, type ProviderResult,
} from "../../lib/providers.js";

const VERSION = "3.2.0";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function authorized(req: Request): boolean {
  const expected = process.env.ACTION_API_KEY?.trim();
  if (!expected) throw new Error("ACTION_API_KEY is not configured");
  return req.headers.get("x-api-key") === expected;
}

function cnNow(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace(" ", "T") + "+08:00";
}

function realtimeSourceFreshness(sourceTime:string|null, activeToleranceSec=360) {
  if(!sourceTime) return {ok:false, reason:"missing_source_time", age_seconds:null as number|null};
  const parsed=Date.parse(sourceTime);
  if(!Number.isFinite(parsed)) return {ok:false, reason:"unparseable_source_time", age_seconds:null as number|null};
  const nowIso=cnNow(), today=nowIso.slice(0,10), sourceDate=sourceTime.slice(0,10);
  const age=Math.max(0,(Date.now()-parsed)/1000);
  if(sourceDate!==today) return {ok:false, reason:`source_date_${sourceDate}_not_current_${today}`, age_seconds:age};
  const hh=Number(nowIso.slice(11,13)), mm=Number(nowIso.slice(14,16)), ss=Number(nowIso.slice(17,19));
  const min=hh*60+mm;
  let allowance=activeToleranceSec;
  if(min>690&&min<780) allowance=(min-690)*60+ss+activeToleranceSec;
  else if(min>900) allowance=(min-900)*60+ss+activeToleranceSec;
  else if(min<570) allowance=activeToleranceSec;
  return {ok:age<=allowance,reason:age<=allowance?"current_market_phase":`age_${Math.round(age)}s_exceeds_${Math.round(allowance)}s`,age_seconds:age};
}

function dateCompact(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replaceAll("-", "");
}

function dateRange(days: number) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(days * 2, 220) * 86400000);
  return { start: dateCompact(start), end: dateCompact(end) };
}

function normalizeCode(raw: string): string {
  let code = raw.trim().toUpperCase();
  if (!code.includes(".")) {
    if (/^6/.test(code)) code += ".SH";
    else if (/^[0123]/.test(code)) code += ".SZ";
    else if (/^[489]/.test(code)) code += ".BJ";
  }
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(code)) throw new Error("Use a Tushare code such as 600522.SH");
  return code;
}

async function safeQuery(api: string, params: Record<string, unknown>, fields = "") {
  try { return { rows: await tushareQuery(api, params, fields), error: null as string | null }; }
  catch (e) { return { rows: [] as Row[], error: e instanceof Error ? e.message : String(e) }; }
}

function numericMedian(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x,y)=>x-y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

function latestRow(rows: Row[], field = "trade_date"): Row | null {
  if (!rows.length) return null;
  return [...rows].sort((a,b)=>String(a[field] || "").localeCompare(String(b[field] || ""))).at(-1) || null;
}

function compactShift(days: number): string {
  return dateCompact(new Date(Date.now() + days * 86400000));
}

async function recentOpenDates(count = 5): Promise<string[]> {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(30, count * 4) * 86400000);
  const rows = await tushareQuery("trade_cal", {
    exchange: "SSE", start_date: dateCompact(start), end_date: dateCompact(end), is_open: "1",
  }, "exchange,cal_date,is_open");
  return rows.map(r=>s(r.cal_date)).filter((x):x is string=>!!x).sort().slice(-count).reverse();
}

const DAILY_BASIC_FIELDS = "ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,pe,pe_ttm,pb,ps,ps_ttm,dv_ratio,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv,limit_status";
const MARGIN_FIELDS = "trade_date,ts_code,name,rzye,rqye,rzmre,rqyl,rzche,rqchl,rqmcl,rzrqye";
const CYQ_FIELDS = "ts_code,trade_date,his_low,his_high,cost_5pct,cost_15pct,cost_50pct,cost_85pct,cost_95pct,weight_avg,winner_rate";
const KPL_FIELDS = "ts_code,name,trade_date,lu_time,ld_time,open_time,last_time,lu_desc,tag,theme,net_change,bid_amount,status,bid_change,bid_turnover,lu_bid_vol,pct_chg,bid_pct_chg,rt_pct_chg,limit_order,amount,turnover_rate,free_float,lu_limit_order";
const TOP_INST_FIELDS = "trade_date,ts_code,exalter,side,buy,buy_rate,sell,sell_rate,net_buy,reason";

async function health() {
  return {
    ok: true,
    service: "tushare-chatgpt-bridge-v3.2-netlify",
    version: VERSION,
    as_of_cn: cnNow(),
    read_only: true,
    endpoints: ["market/overview", "market/scan", "market/themes", "market/sentiment", "stock/snapshot", "stock/context", "stock/intraday", "stock/lhb", "stock/risk-events", "diagnostics/providers"],
  };
}


function normalizeTushareRealtimeQuote(row: Row | null): Row | null {
  if (!row) return null;
  const volShares = n(row.vol);
  return {
    ...enrichRealtime([row])[0],
    vol_hands: volShares !== null ? volShares / 100 : null,
    amount_yuan: n(row.amount),
    source_time: s(row.trade_time),
    provider: "tushare_rt_k",
  };
}

function lastBarQuality(primary: ProviderResult<Row[]> | null, secondary: ProviderResult<Row[]> | null, freq: string) {
  const p = primary?.data.at(-1) || null, q = secondary?.data.at(-1) || null;
  const pc=n(p?.close), qc=n(q?.close);
  const diff=pc!==null&&qc!==null&&pc ? Math.abs(qc-pc)/pc*100 : null;
  const sourceTime=primary?.source_time || s(p?.time);
  const age=sourceTime ? Math.max(0,(Date.now()-Date.parse(sourceTime))/1000) : null;
  const minutes=Math.max(1,Number(freq.replace(/MIN/i,""))||1);
  const baseLimit=Math.max(240,minutes*60+180);
  let allowedAge=baseLimit;
  if(sourceTime){
    const nowParts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date());
    const gv=(k:string)=>nowParts.find(x=>x.type===k)?.value||"";
    const nowDate=`${gv("year")}-${gv("month")}-${gv("day")}`, nowMin=Number(gv("hour"))*60+Number(gv("minute")), nowSec=Number(gv("second"));
    const srcDate=sourceTime.slice(0,10);
    if(srcDate===nowDate){
      if(nowMin>690&&nowMin<780) allowedAge=(nowMin-690)*60+nowSec+baseLimit;
      else if(nowMin>900) allowedAge=(nowMin-900)*60+nowSec+baseLimit;
    }
  }
  let status="usable";
  const warnings:string[]=[];
  if (!primary?.ok) status="fallback";
  else if (diff!==null && (Math.abs((qc||0)-(pc||0))<=0.02 || diff<=0.10)) status="verified";
  else if (diff!==null && diff>0.30) {status="degraded";warnings.push(`Minute sources disagree by ${diff.toFixed(3)}%.`);}
  if(age!==null&&age>allowedAge){status="stale";warnings.push(`Latest ${freq} bar is older than expected for the current market phase (${Math.round(age)} seconds).`);}
  if(primary?.ok&&!secondary?.ok)warnings.push("Minute bars are from one provider only.");
  return {status,primary_source:primary?.source||null,source_time:sourceTime||null,age_seconds:age,cross_check_source:secondary?.ok?secondary.source:null,last_close_difference_pct:diff,warnings};
}

async function preferredFreeMinutes(code:string,freq:string) {
  const [em, sina] = await Promise.all([eastmoneyMinutes(code,freq), sinaMinutes(code,freq)]);
  const primary = em.ok ? em : sina.ok ? sina : em;
  const secondary = em.ok && sina.ok ? sina : null;
  return { primary, secondary, quality: lastBarQuality(primary, secondary, freq), errors:{eastmoney:em.error,sina:sina.error} };
}

async function preferredQuote(code:string, tushareRtRows:Row[]) {
  const [em,sina]=await Promise.all([eastmoneyQuote(code),sinaQuote(code)]);
  const tr=normalizeTushareRealtimeQuote(tushareRtRows.at(0)||null);
  const primary=tr || em.data || sina.data || null;
  const primarySource=tr?"tushare_rt_k":em.data?"eastmoney":sina.data?"sina":null;
  if(primary) primary.provider=primarySource;
  const checks:Array<{source:string;row:Row|null;source_time?:string|null}>=[];
  if(primarySource!=="eastmoney"&&em.data)checks.push({source:"eastmoney",row:em.data,source_time:em.source_time});
  if(primarySource!=="sina"&&sina.data)checks.push({source:"sina",row:sina.data,source_time:sina.source_time});
  const quality=quoteConsensus(primary,checks);
  return {row:primary,source:primarySource,quality,free:{eastmoney:em,sina},tushare_available:!!tr};
}

async function stockIntraday(code: string, url: URL) {
  const freq = (url.searchParams.get("freq") || "5MIN").toUpperCase();
  if (!["1MIN","5MIN","15MIN","30MIN","60MIN"].includes(freq)) throw new Error("freq must be 1MIN/5MIN/15MIN/30MIN/60MIN");
  const tr = await safeQuery("rt_min_daily", { ts_code: code, freq });
  if (tr.rows.length) {
    const rows=[...tr.rows].sort((a,b)=>String(a.time).localeCompare(String(b.time)));
    return {as_of_cn:cnNow(),ts_code:code,freq,data_mode:"realtime",source:"Tushare rt_min_daily",rows,
      quality:{status:"usable",primary_source:"tushare_rt_min_daily",source_time:s(rows.at(-1)?.time),warnings:["Paid Tushare minute feed used as primary source."]},
      provider_errors:{tushare:null,eastmoney:null,sina:null}};
  }
  const free=await preferredFreeMinutes(code,freq);
  if(free.primary.ok) return {as_of_cn:cnNow(),ts_code:code,freq,data_mode:free.quality.status==="stale"?"stale_free_fallback":"realtime_free_fallback",source:free.primary.source,rows:free.primary.data,quality:free.quality,provider_errors:{tushare:tr.error,...free.errors}};
  return {as_of_cn:cnNow(),ts_code:code,freq,data_mode:"unavailable",source:null,rows:[],quality:{status:"fallback",warnings:["No intraday provider returned usable data."]},provider_errors:{tushare:tr.error,...free.errors}};
}

async function stockDaily(code: string, url: URL) {
  const days = Math.max(20, Math.min(500, Number(url.searchParams.get("days") || 120)));
  const { start, end } = dateRange(days);
  const [daily, adj] = await Promise.all([
    tushareQuery("daily", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"),
    tushareQuery("adj_factor", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,adj_factor"),
  ]);
  const qfq = qfqDaily(daily, adj).slice(-days);
  return { as_of_cn: cnNow(), ts_code: code, adjustment: "qfq anchored to latest available adj_factor", rows: qfq };
}

async function stockMoneyflow(code: string, url: URL) {
  const days = Math.max(1, Math.min(120, Number(url.searchParams.get("days") || 20)));
  const { start, end } = dateRange(days);
  let result = await safeQuery("moneyflow_ths", { ts_code: code, start_date: start, end_date: end });
  let source = "Tushare moneyflow_ths";
  if (!result.rows.length) {
    result = await safeQuery("moneyflow", { ts_code: code, start_date: start, end_date: end });
    source = "Tushare moneyflow";
  }
  const rows = [...result.rows].sort((a,b)=>String(a.trade_date).localeCompare(String(b.trade_date))).slice(-days);
  return { as_of_cn: cnNow(), ts_code: code, source, freshness: "post_close", error: result.error, rows };
}

async function stockSnapshot(code: string, url: URL) {
  const freq = (url.searchParams.get("freq") || "5MIN").toUpperCase();
  const days = Math.max(80, Math.min(500, Number(url.searchParams.get("daily_days") || 180)));
  const { start, end } = dateRange(days);

  const [basicR,dailyR,adjR,rtR,minR,flowThsR,dailyBasicR,marginR,cyqR,kplR,emQ,sinaQ] = await Promise.all([
    safeQuery("stock_basic", { ts_code: code, list_status: "L" }, "ts_code,symbol,name,area,industry,market,exchange,list_date"),
    safeQuery("daily", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"),
    safeQuery("adj_factor", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,adj_factor"),
    safeQuery("rt_k", { ts_code: code }), safeQuery("rt_min_daily", { ts_code: code, freq }),
    safeQuery("moneyflow_ths", { ts_code: code, start_date: start, end_date: end }),
    safeQuery("daily_basic", { ts_code: code, start_date: start, end_date: end }, DAILY_BASIC_FIELDS),
    safeQuery("margin_detail", { ts_code: code, start_date: start, end_date: end }, MARGIN_FIELDS),
    safeQuery("cyq_perf", { ts_code: code, start_date: start, end_date: end }, CYQ_FIELDS),
    safeQuery("kpl_list", { ts_code: code, start_date: start, end_date: end }, KPL_FIELDS),
    eastmoneyQuote(code), sinaQuote(code),
  ]);
  if (!dailyR.rows.length) throw new Error("No daily history returned for this code");
  const hist=qfqDaily(dailyR.rows,adjR.rows).slice(-days), latestHist=hist.at(-1)!;
  const tr=normalizeTushareRealtimeQuote(rtR.rows.at(0)||null);
  const rt=tr || emQ.data || sinaQ.data || null;
  const source=tr?"tushare_rt_k":emQ.data?"eastmoney":sinaQ.data?"sina":null;
  if(rt)rt.provider=source;
  const checks:Array<{source:string;row:Row|null;source_time?:string|null}>=[];
  if(source!=="eastmoney"&&emQ.data)checks.push({source:"eastmoney",row:emQ.data,source_time:emQ.source_time});
  if(source!=="sina"&&sinaQ.data)checks.push({source:"sina",row:sinaQ.data,source_time:sinaQ.source_time});
  const quoteQuality=quoteConsensus(rt,checks);

  let minuteRows=[...minR.rows].sort((a,b)=>String(a.time).localeCompare(String(b.time)));
  let minuteSource=minuteRows.length?"tushare_rt_min_daily":null as string|null;
  let minuteQuality:any=minuteRows.length?{status:"usable",primary_source:"tushare_rt_min_daily",source_time:s(minuteRows.at(-1)?.time),warnings:[]}:null;
  let minuteFallbackErrors:any={eastmoney:null,sina:null};
  if(!minuteRows.length){const f=await preferredFreeMinutes(code,freq);if(f.primary.ok){minuteRows=f.primary.data;minuteSource=f.primary.source;minuteQuality=f.quality;}minuteFallbackErrors=f.errors;}

  let flowR=flowThsR, flowSource="Tushare moneyflow_ths";
  if(!flowR.rows.length){flowR=await safeQuery("moneyflow",{ts_code:code,start_date:start,end_date:end});flowSource="Tushare moneyflow";}

  // Keep historical qfq prices on the same live-price basis. On an ex-right/ex-dividend
  // session the exchange realtime pre_close can differ from the latest completed qfq close.
  const realtimePre=n(rt?.pre_close), histLastClose=n(latestHist.close);
  const liveBasisScale=rt&&realtimePre!==null&&histLastClose ? realtimePre/histLastClose : 1;
  const alignedHist=liveBasisScale!==1 ? hist.map(r=>{const out:Row={...r};for(const k of ["open","high","low","close","pre_close"]){const v=n(r[k]);if(v!==null)out[k]=v*liveBasisScale;}return out;}) : hist;
  const quoteSourceDate=s(rt?.source_time)?.slice(0,10).replaceAll("-","")||null;
  const today=dateCompact(new Date());
  const quoteIsTrustedCurrent=!!rt && !!quoteSourceDate && quoteSourceDate===today && ["verified","usable"].includes(String(quoteQuality.status));
  const frame=[...alignedHist];
  if(quoteIsTrustedCurrent&&rt){const histDate=String(latestHist.trade_date||"");if(today!==histDate)frame.push({ts_code:code,trade_date:today,open:rt.open,high:rt.high,low:rt.low,close:rt.close,vol:n(rt.vol_hands),amount:n(rt.amount_yuan)!==null?n(rt.amount_yuan)!/1000:null});}
  const tech=indicators(frame), currentClose=rt?n(rt.close):n(alignedHist.at(-1)?.close), prevClose=rt?n(rt.pre_close):n(alignedHist.at(-1)?.pre_close);
  const avg5xs=hist.slice(-5).map(r=>n(r.vol)).filter((x):x is number=>x!==null),avg5=avg5xs.length?avg5xs.reduce((a,b)=>a+b,0)/avg5xs.length:null;
  const progress=quoteIsTrustedCurrent?chinaTradingProgress():null,currentVolHands=quoteIsTrustedCurrent?n(rt?.vol_hands):null,latestCompletedDailyVolHands=n(latestHist.vol),projected=currentVolHands!==null&&progress&&progress>0?currentVolHands/progress:null;
  const recent20=frame.slice(-20),highs20=recent20.map(r=>n(r.high)).filter((x):x is number=>x!==null),lows20=recent20.map(r=>n(r.low)).filter((x):x is number=>x!==null);
  const latestFlow=latestRow(flowR.rows),latestDailyBasic=latestRow(dailyBasicR.rows),latestMargin=latestRow(marginR.rows),latestCyq=latestRow(cyqR.rows),recentKpl=[...kplR.rows].sort((a,b)=>String(b.trade_date||"").localeCompare(String(a.trade_date||""))).slice(0,10);
  const maDistances:Record<string,number|null>={};for(const key of ["ma5","ma10","ma20","ma60"] as const){const ma=tech[key];maDistances[`${key}_distance_pct`]=currentClose!==null&&ma?(currentClose/ma-1)*100:null;}
  return {
    as_of_cn:cnNow(),market_trade_time:rt?s(rt.source_time)||s(rt.trade_time):null,
    data_mode:rt?(quoteQuality.status==="stale"?"stale_provider_quote":quoteQuality.status==="degraded"?"realtime_degraded":source==="tushare_rt_k"?"realtime_tushare":"realtime_multi_source_fallback"):"latest_completed_daily_fallback",
    data_quality:quoteQuality,
    info:basicR.rows.at(0)||{ts_code:code},quote:rt||latestHist,
    quote_provider:{selected:source,tushare_rt_k_available:!!tr,eastmoney:{ok:emQ.ok,source_time:emQ.source_time,latency_ms:emQ.latency_ms,error:emQ.error},sina:{ok:sinaQ.ok,source_time:sinaQ.source_time,latency_ms:sinaQ.latency_ms,error:sinaQ.error}},
    price_context:{current:currentClose,previous_close:prevClose,pct_from_previous_close:currentClose!==null&&prevClose?(currentClose/prevClose-1)*100:null,...maDistances,recent_20d_high:highs20.length?Math.max(...highs20):null,recent_20d_low:lows20.length?Math.min(...lows20):null},
    technicals:tech,
    volume:{realtime_available:quoteIsTrustedCurrent,current_volume_hands:currentVolHands,latest_completed_daily_volume_hands:latestCompletedDailyVolHands,avg5_daily_volume_hands:avg5,trading_session_progress:progress,projected_full_day_volume_hands:projected,projected_volume_vs_5d_avg:projected!==null&&avg5?projected/avg5:null,note:quoteIsTrustedCurrent?`Current-session volume pace from ${source}.`:"A trusted current-session quote was not verified; projected intraday volume fields are intentionally null."},
    intraday:{available:!!minuteRows.length,freq,bars:minuteRows.length,source:minuteSource,quality:minuteQuality,first_bar:minuteRows.at(0)||null,last_bar:minuteRows.at(-1)||null,provider_errors:{tushare:minR.error,...minuteFallbackErrors}},
    latest_moneyflow:latestFlow,moneyflow_source:latestFlow?flowSource:null,moneyflow_freshness:latestFlow?"post_close":null,
    daily_basic:latestDailyBasic,daily_basic_freshness:latestDailyBasic?"post_close_15_17_cn":null,
    margin:latestMargin,margin_freshness:latestMargin?"exchange_previous_day_update_around_08_30_cn":null,
    chip_cost:latestCyq,chip_cost_freshness:latestCyq?"post_close_18_19_cn_model_estimate":null,recent_limit_board_history:recentKpl,
    permission_errors:{realtime_quote:rtR.error,realtime_minute:minR.error,moneyflow_ths:flowThsR.error,stock_basic:basicR.error,daily_basic:dailyBasicR.error,margin_detail:marginR.error,cyq_perf:cyqR.error,kpl_list:kplR.error},
    fallback_errors:{eastmoney_quote:emQ.error,sina_quote:sinaQ.error,eastmoney_minute:minuteFallbackErrors.eastmoney,sina_minute:minuteFallbackErrors.sina},
    sources:["Tushare daily","Tushare adj_factor",source?`${source} quote`:null,minuteSource?`${minuteSource} minute`:null,latestFlow?flowSource:null,latestDailyBasic?"Tushare daily_basic":null,latestMargin?"Tushare margin_detail":null,latestCyq?"Tushare cyq_perf":null,recentKpl.length?"Tushare kpl_list":null].filter(Boolean),
    notes:["Tushare remains preferred. Free providers are used only when Tushare realtime/advanced permissions are unavailable or their request fails.","Realtime quote quality includes source timestamps when exposed and independent price cross-checks when available.","Daily technicals are calculated on Tushare qfq prices and rescaled to the exchange realtime pre_close basis when necessary (for example an ex-right/ex-dividend session); the current realtime bar is appended only for the active session.","Money-flow and daily_basic are post-close; margin_detail normally reflects the prior trading day.","Free web quote interfaces can change or rate-limit traffic; degraded/conflicting/stale states are surfaced instead of silently accepted."],
  };
}

async function stockContext(code: string, url: URL) {
  const days = Math.max(20, Math.min(240, Number(url.searchParams.get("days") || 90)));
  const { start, end } = dateRange(days);
  const [dailyBasicR, marginR, cyqR, kplR] = await Promise.all([
    safeQuery("daily_basic", { ts_code: code, start_date: start, end_date: end }, DAILY_BASIC_FIELDS),
    safeQuery("margin_detail", { ts_code: code, start_date: start, end_date: end }, MARGIN_FIELDS),
    safeQuery("cyq_perf", { ts_code: code, start_date: start, end_date: end }, CYQ_FIELDS),
    safeQuery("kpl_list", { ts_code: code, start_date: start, end_date: end }, KPL_FIELDS),
  ]);
  return {
    as_of_cn: cnNow(), ts_code: code,
    daily_basic: { freshness: "post_close_15_17_cn", latest: latestRow(dailyBasicR.rows), rows: [...dailyBasicR.rows].sort((a,b)=>String(a.trade_date||"").localeCompare(String(b.trade_date||""))).slice(-20), error: dailyBasicR.error },
    margin_detail: { freshness: "previous_day_update_around_08_30_cn", latest: latestRow(marginR.rows), rows: [...marginR.rows].sort((a,b)=>String(a.trade_date||"").localeCompare(String(b.trade_date||""))).slice(-20), error: marginR.error },
    cyq_perf: { freshness: "post_close_18_19_cn_model_estimate", latest: latestRow(cyqR.rows), rows: [...cyqR.rows].sort((a,b)=>String(a.trade_date||"").localeCompare(String(b.trade_date||""))).slice(-20), error: cyqR.error },
    kpl_list: { freshness: "provider_board_data", rows: [...kplR.rows].sort((a,b)=>String(b.trade_date||"").localeCompare(String(a.trade_date||""))).slice(0, 30), error: kplR.error },
    sources: ["Tushare daily_basic", "Tushare margin_detail", "Tushare cyq_perf", "Tushare kpl_list"],
  };
}

async function stockLhb(code: string, url: URL) {
  const explicit = (url.searchParams.get("trade_date") || "").trim();
  const days = Math.max(1, Math.min(10, Number(url.searchParams.get("days") || 5)));
  const dates = explicit ? [explicit] : await recentOpenDates(days);
  const results = await Promise.all(dates.map(async tradeDate => ({
    trade_date: tradeDate,
    ...(await safeQuery("top_inst", { trade_date: tradeDate, ts_code: code }, TOP_INST_FIELDS)),
  })));
  const sessions = results.filter(x=>x.rows.length).map(x=>({ trade_date: x.trade_date, rows: x.rows, error: x.error }));
  return {
    as_of_cn: cnNow(), ts_code: code, freshness: "post_close", latest_trade_date: sessions.at(0)?.trade_date || null, sessions,
    permission_errors: results.filter(x=>x.error).map(x=>({trade_date:x.trade_date,error:x.error})),
    source: "Tushare top_inst",
    field_note: "side=0 means top-5 buy side; side=1 means top-5 sell side; buy/sell/net_buy are yuan.",
  };
}

async function recentRepurchaseRows(startCompact: string, endCompact: string): Promise<{rows: Row[]; errors: string[]}> {
  const parse = (x: string) => new Date(Date.UTC(Number(x.slice(0,4)), Number(x.slice(4,6))-1, Number(x.slice(6,8))));
  const fmt = (x: Date) => `${x.getUTCFullYear()}${String(x.getUTCMonth()+1).padStart(2,"0")}${String(x.getUTCDate()).padStart(2,"0")}`;
  const start = parse(startCompact), end = parse(endCompact);
  const jobs: Promise<{rows: Row[]; error: string|null}>[] = [];
  for (let cursor = new Date(start); cursor <= end;) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + 29 * 86400000));
    jobs.push(safeQuery("repurchase", { start_date: fmt(cursor), end_date: fmt(chunkEnd) }, "ts_code,ann_date,end_date,proc,exp_date,vol,amount,high_limit,low_limit"));
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  const result = await Promise.all(jobs);
  return { rows: result.flatMap(x=>x.rows), errors: result.map(x=>x.error).filter((x):x is string=>!!x) };
}

async function stockRiskEvents(code: string, url: URL) {
  const forward = Math.max(30, Math.min(365, Number(url.searchParams.get("forward_days") || 90)));
  const backward = Math.max(30, Math.min(365, Number(url.searchParams.get("backward_days") || 120)));
  const today = dateCompact(new Date());
  const futureEnd = compactShift(forward);
  const pastStart = compactShift(-backward);
  const [floatR, holderR, forecastR, disclosureR, repurchaseR] = await Promise.all([
    safeQuery("share_float", { ts_code: code, start_date: today, end_date: futureEnd }, "ts_code,ann_date,float_date,float_share,float_ratio,holder_name,share_type"),
    safeQuery("stk_holdertrade", { ts_code: code, start_date: pastStart, end_date: today }, "ts_code,ann_date,holder_name,holder_type,in_de,change_vol,change_ratio,after_share,after_ratio,avg_price,total_share,begin_date,close_date"),
    safeQuery("forecast", { ts_code: code, start_date: pastStart, end_date: today }, "ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,first_ann_date,summary,change_reason"),
    safeQuery("disclosure_date", { ts_code: code }, "ts_code,ann_date,end_date,pre_date,actual_date,modify_date"),
    recentRepurchaseRows(pastStart, today),
  ]);
  const disclosure = disclosureR.rows
    .filter(r => { const d=String(r.actual_date||r.pre_date||""); return !d || d >= today || String(r.ann_date||"") >= pastStart; })
    .sort((a,b)=>String(a.pre_date||a.actual_date||"").localeCompare(String(b.pre_date||b.actual_date||""))).slice(0,20);
  const repurchases = repurchaseR.rows.filter(r=>String(r.ts_code)===code).sort((a,b)=>String(b.ann_date||"").localeCompare(String(a.ann_date||""))).slice(0,20);
  return {
    as_of_cn: cnNow(), ts_code: code, windows: { backward_days: backward, forward_days: forward },
    upcoming_share_float: { rows: floatR.rows, error: floatR.error },
    recent_holder_trades: { rows: [...holderR.rows].sort((a,b)=>String(b.ann_date||"").localeCompare(String(a.ann_date||""))).slice(0,30), error: holderR.error },
    recent_earnings_forecasts: { rows: [...forecastR.rows].sort((a,b)=>String(b.ann_date||"").localeCompare(String(a.ann_date||""))).slice(0,20), error: forecastR.error },
    disclosure_schedule: { rows: disclosure, error: disclosureR.error },
    recent_repurchase: { rows: repurchases, errors: repurchaseR.errors, note: "repurchase has no ts_code input parameter; service queries the recent market window then filters locally." },
    sources: ["Tushare share_float", "Tushare stk_holdertrade", "Tushare forecast", "Tushare disclosure_date", "Tushare repurchase"],
  };
}


async function preferredRealtimeMarketFull() {
  const tr=await safeQuery("rt_k",{ts_code:A_SHARE_PATTERNS});
  if(tr.rows.length){const rows:Row[]=enrichRealtime(tr.rows).map(r=>({...r,provider:"tushare_rt_k",source_time:s(r.trade_time)} as Row));const st=marketTradeTime(rows),fresh=realtimeSourceFreshness(st);if(fresh.ok)return {rows,source:"tushare_rt_k",coverage:"full",error:null as string|null,provider_errors:{tushare:null,eastmoney:null},source_time:st,source_freshness:fresh};}
  const em=await eastmoneyMarketFullAttempt();
  const emFresh=realtimeSourceFreshness(em.source_time);
  if(em.ok&&em.coverage==="full"&&emFresh.ok)return {rows:em.data,source:"eastmoney",coverage:"full",error:null as string|null,provider_errors:{tushare:tr.error,eastmoney:null},source_time:em.source_time,source_freshness:emFresh};
  return {rows:[] as Row[],source:null as string|null,coverage:em.coverage||"unknown",error:em.error||tr.error,provider_errors:{tushare:tr.error,eastmoney:em.error||(!emFresh.ok?`Eastmoney full-market snapshot rejected: ${emFresh.reason}`:null)},source_time:em.source_time,source_freshness:emFresh};
}

async function preferredQuotesForCodes(codes:string[]) {
  const uniq=[...new Set(codes)].filter(Boolean);if(!uniq.length)return {rows:[] as Row[],source:null as string|null,error:null as string|null};
  try{const rows=await realtimeForCodes(uniq);if(rows.length){const normalized=rows.map(r=>({...r,provider:"tushare_rt_k",source_time:s(r.trade_time)} as Row));const fresh=realtimeSourceFreshness(marketTradeTime(normalized));if(fresh.ok)return {rows:normalized,source:"tushare_rt_k",error:null};}}catch(e){
    const chunks:string[][]=[];for(let i=0;i<uniq.length;i+=80)chunks.push(uniq.slice(i,i+80));const rs=await Promise.all(chunks.map(c=>eastmoneyQuotes(c)));const rows=rs.flatMap(x=>x.data);const st=rs.map(x=>x.source_time).filter((x):x is string=>!!x).sort().at(-1)||null;const fresh=realtimeSourceFreshness(st);if(rows.length&&fresh.ok)return {rows,source:"eastmoney",error:rs.map(x=>x.error).filter(Boolean).join("; ")||null};return {rows:[] as Row[],source:null,error:`Tushare: ${e instanceof Error?e.message:String(e)}; Eastmoney: ${rs.map(x=>x.error).filter(Boolean).join("; ")}; freshness: ${fresh.reason}`};
  }
  // Tushare may return rows that are not current (for example before the market opens);
  // use the same free fallback path instead of silently labeling them realtime.
  const chunks:string[][]=[];for(let i=0;i<uniq.length;i+=80)chunks.push(uniq.slice(i,i+80));const rs=await Promise.all(chunks.map(c=>eastmoneyQuotes(c)));const rows=rs.flatMap(x=>x.data);const st=rs.map(x=>x.source_time).filter((x):x is string=>!!x).sort().at(-1)||null;const fresh=realtimeSourceFreshness(st);if(rows.length&&fresh.ok)return {rows,source:"eastmoney",error:null};
  return {rows:[] as Row[],source:null,error:`No current realtime rows; Eastmoney freshness: ${fresh.reason}`};
}

async function preferredIndices() {
  const tr=await safeQuery("rt_idx_k",{ts_code:"000001.SH,399001.SZ,399006.SZ,000300.SH"});
  if(tr.rows.length){const st=marketTradeTime(tr.rows),fresh=realtimeSourceFreshness(st);if(fresh.ok)return {rows:enrichRealtime(tr.rows).map(r=>({...r,provider:"tushare_rt_idx_k"} as Row)),source:"tushare_rt_idx_k",error:null as string|null,source_time:st,source_freshness:fresh};}
  const em=await eastmoneyIndices();const fresh=realtimeSourceFreshness(em.source_time);return {rows:em.ok&&fresh.ok?em.data:[],source:em.ok&&fresh.ok?"eastmoney":null,error:em.error||(!fresh.ok?`Eastmoney index snapshot rejected: ${fresh.reason}`:tr.error),source_time:em.source_time,permission_error:tr.error,source_freshness:fresh};
}

async function preferredIndustries(topN:number) {
  const tr=await safeQuery("rt_sw_k",{});
  if(tr.rows.length){const st=marketTradeTime(tr.rows),fresh=realtimeSourceFreshness(st);if(fresh.ok){const rows=enrichRealtime(tr.rows).sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,topN);return {rows,source:"tushare_rt_sw_k",error:null as string|null,source_time:st,source_freshness:fresh};}}
  const em=await eastmoneyBoards("industry",Math.max(100,topN));const fresh=realtimeSourceFreshness(em.source_time);return {rows:em.ok&&fresh.ok?em.data.sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,topN):[],source:em.ok&&fresh.ok?"eastmoney_industry":null,error:em.error||(!fresh.ok?`Eastmoney industry snapshot rejected: ${fresh.reason}`:tr.error),permission_error:tr.error,source_time:em.source_time,source_freshness:fresh};
}

async function completedDailyMarketFallback() {
  const openDate = await latestOpenDate();
  const candidates = [openDate];
  const prev = await previousOpenDate(openDate);
  if (prev) candidates.push(prev);
  for (const tradeDate of candidates) {
    const r = await safeQuery(
      "daily",
      { trade_date: tradeDate },
      "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
    );
    if (r.rows.length) {
      const rows:Row[] = r.rows.map(x => ({
        ...x,
        pct_change: n(x.pct_chg),
        // daily.amount is thousand yuan; normalize to yuan to match rt_k semantics.
        amount: n(x.amount) !== null ? n(x.amount)! * 1000 : null,
        risk_name: false,
      } as Row));
      return { rows, trade_date: tradeDate, error: r.error };
    }
  }
  return { rows: [] as Row[], trade_date: null as string | null, error: "No completed daily market snapshot available" };
}

async function marketRowsWithFallback() {
  try {
    const rows = await realtimeMarket();
    return { rows, mode: "realtime" as const, trade_date: latestOpenDate(), realtime_error: null as string | null };
  } catch (e) {
    const fallback = await completedDailyMarketFallback();
    return {
      rows: fallback.rows,
      mode: "post_close_fallback" as const,
      trade_date: Promise.resolve(fallback.trade_date),
      realtime_error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function marketOverview() {
  const live=await preferredRealtimeMarketFull();
  const idx=await preferredIndices();
  let breadthRows=live.rows, breadthMode="realtime_full", breadthDate=await latestOpenDate();
  let fallbackError:string|null=null;
  if(!breadthRows.length){const fb=await completedDailyMarketFallback();breadthRows=fb.rows;breadthMode="post_close_breadth_fallback";breadthDate=fb.trade_date||breadthDate;fallbackError=fb.error;}
  const eligible=breadthRows.filter(r=>!r.risk_name&&n(r.close)!==null&&n(r.pre_close)!==null),pcts=eligible.map(r=>n(r.pct_change)).filter((x):x is number=>x!==null),amount=eligible.reduce((a,r)=>a+(n(r.amount)||0),0);
  let topG=topRows(eligible,"pct_change",12),topD=topRows(eligible,"pct_change",12,false),topA=topRows(eligible,"amount",12);
  let leadersSource=live.rows.length?live.source:"post_close_daily";
  if(!live.rows.length){const [g,d,a]=await Promise.all([eastmoneyMarketRank("pct_change",true,20),eastmoneyMarketRank("pct_change",false,20),eastmoneyMarketRank("amount",true,20)]);const gf=g.ok&&realtimeSourceFreshness(g.source_time).ok,df=d.ok&&realtimeSourceFreshness(d.source_time).ok,af=a.ok&&realtimeSourceFreshness(a.source_time).ok;if(gf)topG=g.data.slice(0,12);if(df)topD=d.data.slice(0,12);if(af)topA=a.data.slice(0,12);if(gf||df||af)leadersSource="eastmoney_ranked_realtime";}
  const realtimeAvailable=!!live.rows.length||!!idx.rows.length||leadersSource==="eastmoney_ranked_realtime";
  return {as_of_cn:cnNow(),data_mode:live.rows.length?`realtime_${live.source}`:realtimeAvailable?"mixed_realtime_plus_post_close_breadth":"post_close_fallback",data_trade_date:breadthDate,
    freshness:{market_breadth:breadthMode,indices:idx.rows.length?"realtime":"unavailable",leaders:leadersSource,market_source_time:live.source_time,index_source_time:idx.source_time},
    data_quality:{status:live.rows.length&&idx.rows.length?"verified_market_sources":realtimeAvailable?"usable_mixed":"fallback",warnings:[...(live.rows.length?[]:["Full realtime market breadth is unavailable; breadth statistics are from the latest completed session."]),...(live.coverage==="ranked_partial"?["Eastmoney full-market response was incomplete and was not used for breadth."]:[])]},
    indices:idx.rows,
    breadth:{freshness:breadthMode,universe:eligible.length,advancers:pcts.filter(x=>x>0).length,decliners:pcts.filter(x=>x<0).length,flat:pcts.filter(x=>Math.abs(x)<1e-12).length,above_5pct:pcts.filter(x=>x>=5).length,below_minus_5pct:pcts.filter(x=>x<=-5).length,above_9_5pct:pcts.filter(x=>x>=9.5).length,below_minus_9_5pct:pcts.filter(x=>x<=-9.5).length,median_pct_change:numericMedian(pcts),total_turnover_yuan:amount},
    leaders:{freshness:leadersSource,top_gainers:topG,top_decliners:topD,top_turnover:topA},
    provider_errors:{realtime_market:live.provider_errors,realtime_indices:idx.error,post_close_fallback:fallbackError},sources:[live.source,idx.source,leadersSource].filter(Boolean)};
}

async function marketScan(url: URL) {
  const sectorTop=Math.max(3,Math.min(15,Number(url.searchParams.get("sector_top_n")||8))),leaderN=Math.max(1,Math.min(8,Number(url.searchParams.get("leaders_per_sector")||4))),marketTop=Math.max(5,Math.min(30,Number(url.searchParams.get("market_top_n")||15))),minAmountM=Math.max(0,Number(url.searchParams.get("min_amount_million")||100));
  const [live,industriesR]=await Promise.all([preferredRealtimeMarketFull(),preferredIndustries(sectorTop)]);
  let eligible:Row[]=live.rows.filter(r=>!r.risk_name&&n(r.close)!==null),topG:Row[]=[],topA:Row[]=[],candidates:Row[]=[],marketSource=live.source,marketCoverage=live.coverage;
  if(eligible.length){const liquid=eligible.filter(r=>(n(r.amount)||0)>=minAmountM*1e6);topG=topRows(eligible,"pct_change",marketTop);topA=topRows(eligible,"amount",marketTop);candidates=liquid.filter(r=>(n(r.pct_change)||0)>0&&(n(r.distance_from_high_pct)||-99)>=-2).sort((a,b)=>(n(b.pct_change)||0)-(n(a.pct_change)||0)||(n(b.amount)||0)-(n(a.amount)||0)).slice(0,marketTop);}
  else{const [g,a]=await Promise.all([eastmoneyMarketRank("pct_change",true,100),eastmoneyMarketRank("amount",true,100)]);const gf=g.ok&&realtimeSourceFreshness(g.source_time).ok,af=a.ok&&realtimeSourceFreshness(a.source_time).ok;topG=gf?g.data.slice(0,marketTop):[];topA=af?a.data.slice(0,marketTop):[];const union=new Map<string,Row>();[...(gf?g.data:[]),...(af?a.data:[])].forEach(r=>union.set(String(r.ts_code),r));eligible=[...union.values()].filter(r=>!r.risk_name);candidates=eligible.filter(r=>(n(r.amount)||0)>=minAmountM*1e6&&(n(r.pct_change)||0)>0&&(n(r.distance_from_high_pct)||-99)>=-2).sort((a,b)=>(n(b.pct_change)||0)-(n(a.pct_change)||0)||(n(b.amount)||0)-(n(a.amount)||0)).slice(0,marketTop);marketSource=(gf||af)?"eastmoney_ranked":null;marketCoverage="ranked_partial";}
  const industryLeaders:Row[]=[];
  for(const sector of industriesR.rows){
    if(industriesR.source==="tushare_rt_sw_k"){
      const code=s(sector.ts_code);if(!code)continue;const membersR=await safeQuery("index_member_all",{l1_code:code,is_new:"Y"},"l1_code,l1_name,ts_code,name,is_new");const codes=membersR.rows.map(r=>s(r.ts_code)).filter((x):x is string=>!!x);const quotes=await preferredQuotesForCodes(codes);industryLeaders.push({sector_code:code,sector_name:sector.name,sector_pct_change:sector.pct_change,leaders:quotes.rows.filter(r=>!r.risk_name).sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,leaderN),member_error:membersR.error,quote_error:quotes.error,quote_source:quotes.source});
    } else {
      const boardCode=s(sector.symbol)||s(sector.ts_code);if(!boardCode)continue;const members=await eastmoneyBoardMembers(boardCode,300);industryLeaders.push({sector_code:boardCode,sector_name:sector.name,sector_pct_change:sector.pct_change,leaders:members.data.filter(r=>!r.risk_name).sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,leaderN),quote_source:"eastmoney_board_members",quote_error:members.error});
    }
  }
  return {as_of_cn:cnNow(),data_mode:marketCoverage==="full"?`realtime_full_${marketSource}`:marketSource?"realtime_ranked_partial":"post_close_only",coverage:marketCoverage,
    freshness_note:marketCoverage==="full"?"Full realtime market cross-section available.":marketSource?"Realtime ranked lists are available, but this is not a complete all-stock universe; candidate scan coverage is partial.":"No realtime provider available.",
    filters:{min_amount_million:minAmountM,momentum_candidate_rule:"positive pct_change; within 2% of intraday high; turnover amount above threshold; excludes ST/退 names"},
    strongest_industries:industriesR.rows,industry_source:industriesR.source,industry_leaders:industryLeaders,top_gainers:topG,top_turnover:topA,liquid_momentum_candidates:candidates,
    provider_errors:{market:live.provider_errors,industry:industriesR.error},sources:[marketSource,industriesR.source].filter(Boolean)};
}

async function latestAvailable(api: string, currentDate: string, params: Record<string, unknown> = {}) {
  const y = Number(currentDate.slice(0,4)), m = Number(currentDate.slice(4,6)), d = Number(currentDate.slice(6,8));
  const end = new Date(Date.UTC(y,m-1,d));
  const start = new Date(end.getTime()-12*86400000);
  const fmt = (x: Date) => `${x.getUTCFullYear()}${String(x.getUTCMonth()+1).padStart(2,"0")}${String(x.getUTCDate()).padStart(2,"0")}`;
  const r = await safeQuery(api, { ...params, start_date: fmt(start), end_date: fmt(end) });
  if (!r.rows.length) return { rows: [] as Row[], trade_date: null as string|null, error: r.error };
  const dates = r.rows.map(x=>s(x.trade_date)).filter((x):x is string=>!!x).sort();
  const latest = dates.at(-1)!;
  return { rows: r.rows.filter(x=>String(x.trade_date)===latest), trade_date: latest, error: r.error };
}

async function evaluateTheme(theme: Row, leaders = 5) {
  const code=s(theme.ts_code)!;const membersR=await safeQuery("ths_member",{ts_code:code});const codes=membersR.rows.map(r=>s(r.con_code)).filter((x):x is string=>!!x);const quotes=await preferredQuotesForCodes(codes);return {ts_code:code,name:theme.name,member_count:codes.length,realtime:summarizeThemeQuotes(quotes.rows.filter(r=>!r.risk_name),leaders),quote_source:quotes.source,errors:{members:membersR.error,realtime_quotes:quotes.error}};
}

async function marketThemes(url: URL) {
  const q=(url.searchParams.get("q")||"").trim(),topN=Math.max(3,Math.min(15,Number(url.searchParams.get("top_n")||8))),leaders=Math.max(3,Math.min(10,Number(url.searchParams.get("leaders")||5))),openDate=await latestOpenDate();
  const [strong,flow]=await Promise.all([latestAvailable("limit_cpt_list",openDate),latestAvailable("moneyflow_cnt_ths",openDate)]);
  const postCloseStrong=sortNumeric(strong.rows,"rank",false).slice(0,topN),postCloseFlow=sortNumeric(flow.rows,"net_amount",true).slice(0,topN);
  let matched:Row[]=[],evaluated:any[]=[],themeSource:string|null=null,searchErrors:any={tushare:null,eastmoney:null};
  if(q){const terms=q.split(/[,，]/).map(x=>x.trim().toLowerCase()).filter(Boolean);const idxR=await safeQuery("ths_index",{exchange:"A",type:"N"});searchErrors.tushare=idxR.error;matched=idxR.rows.filter(r=>terms.some(t=>String(r.name||"").toLowerCase().includes(t))).slice(0,6);
    if(matched.length){evaluated=await Promise.all(matched.map(t=>evaluateTheme(t,leaders)));themeSource="tushare_ths_members_with_preferred_quotes";}
    else {const emBoards=await eastmoneyBoards("concept",400);searchErrors.eastmoney=emBoards.error;matched=emBoards.data.filter(r=>terms.some(t=>String(r.name||"").toLowerCase().includes(t))).slice(0,6);evaluated=await Promise.all(matched.map(async b=>{const bc=s(b.symbol)||s(b.ts_code)||"";const members=await eastmoneyBoardMembers(bc,500);const fresh=realtimeSourceFreshness(members.source_time);const rows=members.ok&&fresh.ok?members.data:[];return {board_code:bc,name:b.name,member_count:members.data.length,realtime:rows.length?summarizeThemeQuotes(rows.filter(r=>!r.risk_name),leaders):null,quote_source:rows.length?"eastmoney_board_members":null,coverage:members.coverage,source_time:members.source_time,data_quality:fresh,error:members.error||(!fresh.ok?`Member quotes rejected: ${fresh.reason}`:null)};}));themeSource=emBoards.ok?"eastmoney_concept":"unavailable";}
  }
  return {as_of_cn:cnNow(),query:q||null,realtime_theme_evaluation:evaluated,matched_theme_definitions:matched,realtime_theme_source:themeSource,
    latest_strong_theme_board:{freshness:"post_close",trade_date:strong.trade_date,rows:postCloseStrong,error:strong.error},latest_theme_moneyflow:{freshness:"post_close",trade_date:flow.trade_date,rows:postCloseFlow,error:flow.error},search_errors:searchErrors,
    sources:[themeSource,"Tushare limit_cpt_list","Tushare moneyflow_cnt_ths"].filter(Boolean),notes:["Tushare THS definitions are preferred when permitted; Eastmoney concept boards are used when those permissions are unavailable.","Strong-theme board and concept money-flow datasets are post-close and explicitly dated."]};
}

async function marketSentiment() {
  const full=await preferredRealtimeMarketFull();let market=full.rows,mode=market.length?`realtime_full_${full.source}`:"post_close_fallback",coverage=full.coverage,tradeDate=await latestOpenDate(),partialWarning:string|null=null;
  if(!market.length){const [g,d]=await Promise.all([eastmoneyMarketRank("pct_change",true,100),eastmoneyMarketRank("pct_change",false,100)]);const gf=g.ok&&realtimeSourceFreshness(g.source_time).ok,df=d.ok&&realtimeSourceFreshness(d.source_time).ok;if(gf||df){const m=new Map<string,Row>();[...(gf?g.data:[]),...(df?d.data:[])].forEach(r=>m.set(String(r.ts_code),r));market=[...m.values()];mode="realtime_ranked_partial";coverage="ranked_partial";partialWarning="Limit-up/down observations are based on ranked realtime subsets and counts are lower bounds, not guaranteed whole-market totals.";}else{const fb=await completedDailyMarketFallback();market=fb.rows;tradeDate=fb.trade_date||tradeDate;mode="post_close_fallback";coverage="full";}}
  const prevDate=await previousOpenDate(tradeDate);
  const [limitsR,prevStepR,strongR,kplUpR,kplBreakR,kplDownR,kplAuctionR]=await Promise.all([safeQuery("stk_limit",{trade_date:tradeDate},"trade_date,ts_code,pre_close,up_limit,down_limit"),prevDate?safeQuery("limit_step",{trade_date:prevDate}):Promise.resolve({rows:[] as Row[],error:null as string|null}),prevDate?safeQuery("limit_cpt_list",{trade_date:prevDate}):Promise.resolve({rows:[] as Row[],error:null as string|null}),safeQuery("kpl_list",{trade_date:tradeDate,tag:"涨停"},KPL_FIELDS),safeQuery("kpl_list",{trade_date:tradeDate,tag:"炸板"},KPL_FIELDS),safeQuery("kpl_list",{trade_date:tradeDate,tag:"跌停"},KPL_FIELDS),safeQuery("kpl_list",{trade_date:tradeDate,tag:"竞价"},KPL_FIELDS)]);
  const lmap=new Map(limitsR.rows.map(r=>[String(r.ts_code),r])),kplMap=new Map([...kplUpR.rows,...kplBreakR.rows,...kplDownR.rows].map(r=>[String(r.ts_code),r])),prevStreak=new Map(prevStepR.rows.map(r=>[String(r.ts_code),Number(r.nums)||1]));const sealedUp:Row[]=[],openedBoard:Row[]=[],sealedDown:Row[]=[];
  for(const row of market){if(row.risk_name)continue;const lim=lmap.get(String(row.ts_code));if(!lim)continue;const close=n(row.close),high=n(row.high),up=n(lim.up_limit),down=n(lim.down_limit);if(close===null||up===null||down===null)continue;const eps=Math.max(0.001,close*0.00005),hitUp=high!==null&&high>=up-eps,isUp=close>=up-eps,isDown=close<=down+eps;if(isUp)sealedUp.push({...row,up_limit:up,estimated_streak:(prevStreak.get(String(row.ts_code))||0)+1,kpl:kplMap.get(String(row.ts_code))||null});else if(hitUp)openedBoard.push({...row,up_limit:up,kpl:kplMap.get(String(row.ts_code))||null});if(isDown)sealedDown.push({...row,down_limit:down,kpl:kplMap.get(String(row.ts_code))||null});}
  const ladder:Record<string,number>={};for(const r of sealedUp){const k=String(r.estimated_streak||1);ladder[k]=(ladder[k]||0)+1;}const pcts=market.filter(r=>!r.risk_name).map(r=>n(r.pct_change)).filter((x):x is number=>x!==null),maxStreak=sealedUp.reduce((m,r)=>Math.max(m,Number(r.estimated_streak)||1),0);
  return {as_of_cn:cnNow(),data_mode:mode,coverage,count_semantics:coverage==="full"?"whole_market":"observed_lower_bound",freshness_note:mode.startsWith("realtime")?"Board status computed from available realtime quotes versus official Tushare limit prices.":`Board status reconstructed from completed daily data for ${tradeDate}.`,trade_date:tradeDate,
    realtime_temperature:{sealed_limit_up_count:sealedUp.length,opened_limit_up_board_count:openedBoard.length,sealed_limit_down_count:sealedDown.length,above_5pct_count:pcts.filter(x=>x>=5).length,below_minus_5pct_count:pcts.filter(x=>x<=-5).length,advancers:pcts.filter(x=>x>0).length,decliners:pcts.filter(x=>x<0).length,max_estimated_streak:maxStreak,estimated_streak_ladder:ladder},sealed_limit_up:sortNumeric(sealedUp,"estimated_streak",true).slice(0,40),opened_boards:sortNumeric(openedBoard,"pct_change",true).slice(0,30),sealed_limit_down:sortNumeric(sealedDown,"pct_change",false).slice(0,30),previous_trade_date:prevDate,previous_day_strong_themes:sortNumeric(strongR.rows,"rank",false).slice(0,12),provider_board_lists:{freshness:"kpl_provider_trade_date_when_available",limit_up:kplUpR.rows.slice(0,80),opened_board:kplBreakR.rows.slice(0,80),limit_down:kplDownR.rows.slice(0,80),auction:kplAuctionR.rows.slice(0,80)},
    permission_errors:{rt_k:full.provider_errors.tushare,stk_limit:limitsR.error,previous_limit_step:prevStepR.error,previous_limit_cpt_list:strongR.error,kpl_limit_up:kplUpR.error,kpl_opened_board:kplBreakR.error,kpl_limit_down:kplDownR.error,kpl_auction:kplAuctionR.error},provider_errors:{eastmoney:full.provider_errors.eastmoney},sources:[full.source||mode,"Tushare stk_limit","Tushare limit_step","Tushare limit_cpt_list","Tushare kpl_list"],notes:[partialWarning,"Tushare realtime is always preferred. Free realtime providers are only fallbacks.","If realtime coverage is partial, counts are explicitly labeled lower bounds rather than whole-market totals.","estimated_streak uses Tushare limit_step when available; without that permission it should not be treated as an authoritative streak count."].filter(Boolean)};
}

async function providerDiagnostics(url:URL){
  const code=normalizeCode(url.searchParams.get("ts_code")||"600522.SH"),freq=(url.searchParams.get("freq")||"5MIN").toUpperCase();
  const [trQ,trM,emQ,siQ,emM,siM,emRank,emInd]=await Promise.all([safeQuery("rt_k",{ts_code:code}),safeQuery("rt_min_daily",{ts_code:code,freq}),eastmoneyQuote(code),sinaQuote(code),eastmoneyMinutes(code,freq),sinaMinutes(code,freq),eastmoneyMarketRank("pct_change",true,5),eastmoneyBoards("industry",10)]);
  const tr=normalizeTushareRealtimeQuote(trQ.rows.at(0)||null),primary=tr||emQ.data||siQ.data||null;const checks:Array<{source:string;row:Row|null;source_time?:string|null}>=[];if(primary!==emQ.data&&emQ.data)checks.push({source:"eastmoney",row:emQ.data,source_time:emQ.source_time});if(primary!==siQ.data&&siQ.data)checks.push({source:"sina",row:siQ.data,source_time:siQ.source_time});
  return {as_of_cn:cnNow(),ts_code:code,quote_consensus:quoteConsensus(primary,checks),providers:{tushare_rt_k:{ok:!!tr,error:trQ.error,row:tr},tushare_rt_min_daily:{ok:!!trM.rows.length,error:trM.error,last_bar:trM.rows.at(-1)||null},eastmoney_quote:{ok:emQ.ok,error:emQ.error,source_time:emQ.source_time,latency_ms:emQ.latency_ms,row:emQ.data},sina_quote:{ok:siQ.ok,error:siQ.error,source_time:siQ.source_time,latency_ms:siQ.latency_ms,row:siQ.data},eastmoney_minute:{ok:emM.ok,error:emM.error,source_time:emM.source_time,latency_ms:emM.latency_ms,last_bar:emM.data.at(-1)||null},sina_minute:{ok:siM.ok,error:siM.error,source_time:siM.source_time,latency_ms:siM.latency_ms,last_bar:siM.data.at(-1)||null},eastmoney_market_rank:{ok:emRank.ok,error:emRank.error,latency_ms:emRank.latency_ms,rows:emRank.data.length},eastmoney_industry:{ok:emInd.ok,error:emInd.error,latency_ms:emInd.latency_ms,rows:emInd.data.length}},notes:["Use this endpoint after deployment to verify which free providers are reachable from the Netlify egress IP.","A provider marked ok does not by itself prove independent accuracy; quote_consensus compares returned prices when multiple sources are available."]};
}

export default async (req: Request, context: any) => {
  try {
    if (!authorized(req)) return json({ error: "unauthorized" }, 401);
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health") return json(await health());
    if (path === "/market/overview") return json(await marketOverview());
    if (path === "/market/scan") return json(await marketScan(url));
    if (path === "/market/themes") return json(await marketThemes(url));
    if (path === "/market/sentiment") return json(await marketSentiment());
    if (path === "/diagnostics/providers") return json(await providerDiagnostics(url));

    const match = path.match(/^\/stock\/([^/]+)\/(snapshot|context|intraday|daily|moneyflow|lhb|risk-events)$/);
    if (match) {
      const code = normalizeCode(decodeURIComponent(match[1]));
      const action = match[2];
      if (action === "snapshot") return json(await stockSnapshot(code, url));
      if (action === "context") return json(await stockContext(code, url));
      if (action === "lhb") return json(await stockLhb(code, url));
      if (action === "risk-events") return json(await stockRiskEvents(code, url));
      if (action === "intraday") return json(await stockIntraday(code, url));
      if (action === "daily") return json(await stockDaily(code, url));
      if (action === "moneyflow") return json(await stockMoneyflow(code, url));
    }
    return json({ error: "not_found", path }, 404);
  } catch (e) {
    const status = e instanceof TushareError ? 502 : 400;
    return json({
      error: e instanceof TushareError ? "tushare_error" : "request_error",
      detail: e instanceof Error ? e.message : String(e),
      code: e instanceof TushareError ? e.code : undefined,
    }, status);
  }
};

export const config = {
  path: [
    "/health",
    "/market/overview",
    "/market/scan",
    "/market/themes",
    "/market/sentiment",
    "/diagnostics/providers",
    "/stock/:ts_code/snapshot",
    "/stock/:ts_code/context",
    "/stock/:ts_code/lhb",
    "/stock/:ts_code/risk-events",
    "/stock/:ts_code/intraday",
    "/stock/:ts_code/daily",
    "/stock/:ts_code/moneyflow"
  ],
  method: "GET",
};
