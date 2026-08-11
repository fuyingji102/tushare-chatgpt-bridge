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
import { analyzeBreakout, classifyRegime, clamp, median as strategyMedian, pctRank, type RegimeLabel } from "../../lib/strategy.js";
import {
  eastmoneyBoardMembers, eastmoneyBoards, eastmoneyIndices, eastmoneyMarketFullAttempt,
  eastmoneyMarketRank, eastmoneyMinutes, eastmoneyQuote, eastmoneyQuotes, quoteConsensus,
  sinaMinutes, sinaQuote, tencentIndices, tencentQuote, tencentQuotes, tencentQuotesBatched, type ProviderResult,
} from "../../lib/providers.js";

const VERSION = "3.2.2";
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

const INDEX_DEFS = [
  { ts_code:"000001.SH", name:"上证指数", style:"broad_main" },
  { ts_code:"000016.SH", name:"上证50", style:"large_value" },
  { ts_code:"000300.SH", name:"沪深300", style:"large_core" },
  { ts_code:"000905.SH", name:"中证500", style:"mid_cap" },
  { ts_code:"000852.SH", name:"中证1000", style:"small_mid" },
  { ts_code:"399001.SZ", name:"深证成指", style:"shenzhen_broad" },
  { ts_code:"399006.SZ", name:"创业板指", style:"growth" },
  { ts_code:"000688.SH", name:"科创50", style:"star_growth" },
  { ts_code:"931643.CSI", name:"科创创业50", style:"dual_innovation" },
  { ts_code:"932000.CSI", name:"中证2000", style:"micro_small" },
] as const;

function consensusScalar(values:Array<{source:string;value:number|null}>, ratioTolerance=0.06){
  const xs=values.filter(x=>x.value!==null&&Number.isFinite(x.value!)&&x.value!>=0) as Array<{source:string;value:number}>;
  if(!xs.length)return {value:null as number|null,status:"missing",sources:[] as string[],raw:values,warning:"No provider value available."};
  if(xs.length===1)return {value:xs[0].value,status:"single",sources:[xs[0].source],raw:values,warning:null as string|null};
  let best:Array<{source:string;value:number}>=[];
  for(const seed of xs){const cluster=xs.filter(x=>seed.value===0?x.value===0:Math.abs(x.value/seed.value-1)<=ratioTolerance);if(cluster.length>best.length)best=cluster;}
  if(best.length>=2){const val=numericMedian(best.map(x=>x.value));const outliers=xs.filter(x=>!best.includes(x));return {value:val,status:outliers.length?"normalized_outlier":"verified",sources:best.map(x=>x.source),raw:values,warning:outliers.length?`Ignored provider scale/outlier values from ${outliers.map(x=>x.source).join(", ")}.`:null};}
  const logs=xs.filter(x=>x.value>0).map(x=>Math.log10(x.value));
  const spread=logs.length?Math.max(...logs)-Math.min(...logs):0;
  return {value:numericMedian(xs.map(x=>x.value)),status:spread>1.5?"scale_conflict":"disagreement",sources:xs.map(x=>x.source),raw:values,warning:spread>1.5?"Provider values differ by orders of magnitude; median used only as a defensive normalization.":"Providers disagree beyond tolerance; median used."};
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
    service: "tushare-chatgpt-bridge-v3.2.2-netlify",
    version: VERSION,
    as_of_cn: cnNow(),
    read_only: true,
    endpoints: ["market/overview", "market/sentiment", "market/sectors", "market/breakouts", "market/scan", "market/themes", "stock/snapshot", "stock/context", "stock/intraday", "stock/lhb", "stock/risk-events", "diagnostics/providers"],
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
  const [tx,em,sina]=await Promise.all([tencentQuote(code),eastmoneyQuote(code),sinaQuote(code)]);
  const tr=normalizeTushareRealtimeQuote(tushareRtRows.at(0)||null);
  const primary=tr || tx.data || em.data || sina.data || null;
  const primarySource=tr?"tushare_rt_k":tx.data?"tencent":em.data?"eastmoney":sina.data?"sina":null;
  if(primary) primary.provider=primarySource;
  const checks:Array<{source:string;row:Row|null;source_time?:string|null}>=[];
  if(primarySource!=="tencent"&&tx.data)checks.push({source:"tencent",row:tx.data,source_time:tx.source_time});
  if(primarySource!=="eastmoney"&&em.data)checks.push({source:"eastmoney",row:em.data,source_time:em.source_time});
  if(primarySource!=="sina"&&sina.data)checks.push({source:"sina",row:sina.data,source_time:sina.source_time});
  const quality=quoteConsensus(primary,checks);
  return {row:primary,source:primarySource,quality,free:{tencent:tx,eastmoney:em,sina},tushare_available:!!tr};
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

  const [basicR,dailyR,adjR,rtR,minR,flowThsR,dailyBasicR,marginR,cyqR,kplR,txQ,emQ,sinaQ] = await Promise.all([
    safeQuery("stock_basic", { ts_code: code, list_status: "L" }, "ts_code,symbol,name,area,industry,market,exchange,list_date"),
    safeQuery("daily", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"),
    safeQuery("adj_factor", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,adj_factor"),
    safeQuery("rt_k", { ts_code: code }), safeQuery("rt_min_daily", { ts_code: code, freq }),
    safeQuery("moneyflow_ths", { ts_code: code, start_date: start, end_date: end }),
    safeQuery("daily_basic", { ts_code: code, start_date: start, end_date: end }, DAILY_BASIC_FIELDS),
    safeQuery("margin_detail", { ts_code: code, start_date: start, end_date: end }, MARGIN_FIELDS),
    safeQuery("cyq_perf", { ts_code: code, start_date: start, end_date: end }, CYQ_FIELDS),
    safeQuery("kpl_list", { ts_code: code, start_date: start, end_date: end }, KPL_FIELDS),
    tencentQuote(code), eastmoneyQuote(code), sinaQuote(code),
  ]);
  if (!dailyR.rows.length) throw new Error("No daily history returned for this code");
  const hist=qfqDaily(dailyR.rows,adjR.rows).slice(-days), latestHist=hist.at(-1)!;
  const tr=normalizeTushareRealtimeQuote(rtR.rows.at(0)||null);
  const rt=tr || txQ.data || emQ.data || sinaQ.data || null;
  const source=tr?"tushare_rt_k":txQ.data?"tencent":emQ.data?"eastmoney":sinaQ.data?"sina":null;
  if(rt)rt.provider=source;
  const checks:Array<{source:string;row:Row|null;source_time?:string|null}>=[];
  if(source!=="tencent"&&txQ.data)checks.push({source:"tencent",row:txQ.data,source_time:txQ.source_time});
  if(source!=="eastmoney"&&emQ.data)checks.push({source:"eastmoney",row:emQ.data,source_time:emQ.source_time});
  if(source!=="sina"&&sinaQ.data)checks.push({source:"sina",row:sinaQ.data,source_time:sinaQ.source_time});
  const quoteQuality=quoteConsensus(rt,checks);
  const volumeConsensus=consensusScalar([
    {source:"tushare_rt_k",value:tr?n(tr.vol_hands):null},
    {source:"tencent",value:txQ.data?n(txQ.data.vol_hands):null},
    {source:"eastmoney",value:emQ.data?n(emQ.data.vol_hands):null},
    {source:"sina",value:sinaQ.data?n(sinaQ.data.vol_hands):null},
  ],0.08);
  const amountConsensus=consensusScalar([
    {source:"tushare_rt_k",value:tr?n(tr.amount_yuan):null},
    {source:"tencent",value:txQ.data?n(txQ.data.amount_yuan)??n(txQ.data.amount):null},
    {source:"eastmoney",value:emQ.data?n(emQ.data.amount_yuan)??n(emQ.data.amount):null},
    {source:"sina",value:sinaQ.data?n(sinaQ.data.amount_yuan)??n(sinaQ.data.amount):null},
  ],0.08);
  if(rt&&volumeConsensus.value!==null){rt.vol_hands=volumeConsensus.value;rt.vol=volumeConsensus.value;}
  if(rt&&amountConsensus.value!==null){rt.amount_yuan=amountConsensus.value;rt.amount=amountConsensus.value;}

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
    quote_provider:{selected:source,tushare_rt_k_available:!!tr,volume_consensus:volumeConsensus,amount_consensus:amountConsensus,tencent:{ok:txQ.ok,source_time:txQ.source_time,latency_ms:txQ.latency_ms,error:txQ.error},eastmoney:{ok:emQ.ok,source_time:emQ.source_time,latency_ms:emQ.latency_ms,error:emQ.error},sina:{ok:sinaQ.ok,source_time:sinaQ.source_time,latency_ms:sinaQ.latency_ms,error:sinaQ.error}},
    price_context:{current:currentClose,previous_close:prevClose,pct_from_previous_close:currentClose!==null&&prevClose?(currentClose/prevClose-1)*100:null,...maDistances,recent_20d_high:highs20.length?Math.max(...highs20):null,recent_20d_low:lows20.length?Math.min(...lows20):null},
    technicals:tech,
    volume:{realtime_available:quoteIsTrustedCurrent,current_volume_hands:currentVolHands,latest_completed_daily_volume_hands:latestCompletedDailyVolHands,avg5_daily_volume_hands:avg5,trading_session_progress:progress,projected_full_day_volume_hands:projected,projected_volume_vs_5d_avg:projected!==null&&avg5?projected/avg5:null,note:quoteIsTrustedCurrent?`Current-session volume pace from ${source}.`:"A trusted current-session quote was not verified; projected intraday volume fields are intentionally null."},
    intraday:{available:!!minuteRows.length,freq,bars:minuteRows.length,source:minuteSource,quality:minuteQuality,first_bar:minuteRows.at(0)||null,last_bar:minuteRows.at(-1)||null,provider_errors:{tushare:minR.error,...minuteFallbackErrors}},
    latest_moneyflow:latestFlow,moneyflow_source:latestFlow?flowSource:null,moneyflow_freshness:latestFlow?"post_close":null,
    daily_basic:latestDailyBasic,daily_basic_freshness:latestDailyBasic?"post_close_15_17_cn":null,
    margin:latestMargin,margin_freshness:latestMargin?"exchange_previous_day_update_around_08_30_cn":null,
    chip_cost:latestCyq,chip_cost_freshness:latestCyq?"post_close_18_19_cn_model_estimate":null,recent_limit_board_history:recentKpl,
    permission_errors:{realtime_quote:rtR.error,realtime_minute:minR.error,moneyflow_ths:flowThsR.error,stock_basic:basicR.error,daily_basic:dailyBasicR.error,margin_detail:marginR.error,cyq_perf:cyqR.error,kpl_list:kplR.error},
    fallback_errors:{tencent_quote:txQ.error,eastmoney_quote:emQ.error,sina_quote:sinaQ.error,eastmoney_minute:minuteFallbackErrors.eastmoney,sina_minute:minuteFallbackErrors.sina},
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
  if(tr.rows.length){const rows:Row[]=enrichRealtime(tr.rows).map(r=>({...r,provider:"tushare_rt_k",source_time:s(r.trade_time)} as Row));const st=marketTradeTime(rows),fresh=realtimeSourceFreshness(st);if(fresh.ok)return {rows,source:"tushare_rt_k",coverage:"full",error:null as string|null,provider_errors:{tushare:null,tencent:null,eastmoney:null,stock_basic:null},source_time:st,source_freshness:fresh};}

  // With no paid rt_k permission, use Tushare's listed-stock universe as the authoritative
  // symbol set and Tencent only as the current quote transport. This lets us measure coverage
  // instead of assuming that a ranked webpage response represents the whole market.
  const basic=await safeQuery("stock_basic",{list_status:"L"},"ts_code,symbol,name,industry,market,exchange,list_date");
  if(basic.rows.length){
    const meta=new Map(basic.rows.map(r=>[String(r.ts_code),r]));
    const tx=await tencentQuotesBatched(basic.rows.map(r=>String(r.ts_code)).filter(Boolean));
    const txFresh=realtimeSourceFreshness(tx.source_time);
    if(tx.ok&&tx.coverage==="full"&&txFresh.ok){
      const rows=tx.data.map(r=>({...meta.get(String(r.ts_code)),...r,provider:"tencent"} as Row));
      return {rows,source:"tencent",coverage:"full",error:tx.error,provider_errors:{tushare:tr.error,tencent:tx.error,eastmoney:null,stock_basic:basic.error},source_time:tx.source_time,source_freshness:txFresh};
    }
  }

  const em=await eastmoneyMarketFullAttempt();
  const emFresh=realtimeSourceFreshness(em.source_time);
  if(em.ok&&em.coverage==="full"&&emFresh.ok)return {rows:em.data,source:"eastmoney",coverage:"full",error:null as string|null,provider_errors:{tushare:tr.error,tencent:"Tencent full-market coverage unavailable",eastmoney:null,stock_basic:basic.error},source_time:em.source_time,source_freshness:emFresh};
  return {rows:[] as Row[],source:null as string|null,coverage:em.coverage||"unknown",error:em.error||tr.error,provider_errors:{tushare:tr.error,tencent:"Tencent full-market coverage unavailable or stale",eastmoney:em.error||(!emFresh.ok?`Eastmoney full-market snapshot rejected: ${emFresh.reason}`:null),stock_basic:basic.error},source_time:em.source_time,source_freshness:emFresh};
}

async function preferredQuotesForCodes(codes:string[]) {
  const uniq=[...new Set(codes)].filter(Boolean);if(!uniq.length)return {rows:[] as Row[],source:null as string|null,error:null as string|null};
  try{const rows=await realtimeForCodes(uniq);if(rows.length){const normalized=rows.map(r=>({...r,provider:"tushare_rt_k",source_time:s(r.trade_time)} as Row));const fresh=realtimeSourceFreshness(marketTradeTime(normalized));if(fresh.ok)return {rows:normalized,source:"tushare_rt_k",error:null};}}catch(e){
    const tx=await tencentQuotesBatched(uniq,90,8);const txFresh=realtimeSourceFreshness(tx.source_time);if(tx.data.length&&txFresh.ok)return {rows:tx.data,source:"tencent",error:tx.error};
    const chunks:string[][]=[];for(let i=0;i<uniq.length;i+=80)chunks.push(uniq.slice(i,i+80));const rs=await Promise.all(chunks.map(c=>eastmoneyQuotes(c)));const rows=rs.flatMap(x=>x.data);const st=rs.map(x=>x.source_time).filter((x):x is string=>!!x).sort().at(-1)||null;const fresh=realtimeSourceFreshness(st);if(rows.length&&fresh.ok)return {rows,source:"eastmoney",error:rs.map(x=>x.error).filter(Boolean).join("; ")||null};return {rows:[] as Row[],source:null,error:`Tushare: ${e instanceof Error?e.message:String(e)}; Tencent: ${tx.error}; Eastmoney: ${rs.map(x=>x.error).filter(Boolean).join("; ")}; freshness: ${fresh.reason}`};
  }
  const tx=await tencentQuotesBatched(uniq,90,8);const txFresh=realtimeSourceFreshness(tx.source_time);if(tx.data.length&&txFresh.ok)return {rows:tx.data,source:"tencent",error:tx.error};
  const chunks:string[][]=[];for(let i=0;i<uniq.length;i+=80)chunks.push(uniq.slice(i,i+80));const rs=await Promise.all(chunks.map(c=>eastmoneyQuotes(c)));const rows=rs.flatMap(x=>x.data);const st=rs.map(x=>x.source_time).filter((x):x is string=>!!x).sort().at(-1)||null;const fresh=realtimeSourceFreshness(st);if(rows.length&&fresh.ok)return {rows,source:"eastmoney",error:null};
  return {rows:[] as Row[],source:null,error:`No current realtime rows; Tencent: ${tx.error}; Eastmoney freshness: ${fresh.reason}`};
}

async function preferredIndices() {
  const requested=INDEX_DEFS.map(x=>x.ts_code).join(",");
  const tr=await safeQuery("rt_idx_k",{ts_code:requested});
  if(tr.rows.length){const st=marketTradeTime(tr.rows),fresh=realtimeSourceFreshness(st);if(fresh.ok)return {rows:enrichRealtime(tr.rows).map(r=>({...r,provider:"tushare_rt_idx_k"} as Row)),source:"tushare_rt_idx_k",error:null as string|null,source_time:st,source_freshness:fresh};}
  const tx=await tencentIndices();const txFresh=realtimeSourceFreshness(tx.source_time);
  if(tx.ok&&txFresh.ok)return {rows:tx.data,source:"tencent",error:tx.error,source_time:tx.source_time,permission_error:tr.error,source_freshness:txFresh};
  const em=await eastmoneyIndices();const fresh=realtimeSourceFreshness(em.source_time);return {rows:em.ok&&fresh.ok?em.data:[],source:em.ok&&fresh.ok?"eastmoney":null,error:tx.error||em.error||(!fresh.ok?`Eastmoney index snapshot rejected: ${fresh.reason}`:tr.error),source_time:em.source_time,permission_error:tr.error,source_freshness:fresh};
}

function returnFromRows(rows:Row[],days:number){
  const xs=[...rows].sort((a,b)=>String(a.trade_date||"").localeCompare(String(b.trade_date||"")));
  if(xs.length<2)return null;const end=n(xs.at(-1)?.close);const base=n(xs.at(-Math.min(days+1,xs.length))?.close);return end!==null&&base?(end/base-1)*100:null;
}

async function indexMatrix(prefetched?:Awaited<ReturnType<typeof preferredIndices>>) {
  const idx=prefetched||await preferredIndices();const liveMap=new Map(idx.rows.map(r=>[String(r.ts_code),r]));
  const {start,end}=dateRange(150);
  const histories=await Promise.all(INDEX_DEFS.map(async def=>{
    const h=await safeQuery("index_daily",{ts_code:def.ts_code,start_date:start,end_date:end},"ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount");
    return {def,h};
  }));
  const today=dateCompact(new Date());
  const rows=histories.map(({def,h})=>{
    const hist=[...h.rows].sort((a,b)=>String(a.trade_date||"").localeCompare(String(b.trade_date||""))).slice(-140);
    const live=liveMap.get(def.ts_code)||null;
    const liveDate=s(live?.source_time)?.slice(0,10).replaceAll("-","")||null;
    const frame=[...hist];
    if(live&&liveDate===today&&String(hist.at(-1)?.trade_date||"")!==today)frame.push({...live,trade_date:today});
    const tech=indicators(frame);const current=live&&liveDate===today?n(live.close):n(hist.at(-1)?.close);
    const high=n(live?.high)??n(hist.at(-1)?.high),low=n(live?.low)??n(hist.at(-1)?.low);
    const dayPosition=current!==null&&high!==null&&low!==null&&high>low?(current-low)/(high-low):null;
    const vols=hist.slice(-5).map(r=>n(r.vol)).filter((x):x is number=>x!==null);const avg5=vols.length?vols.reduce((a,b)=>a+b,0)/vols.length:null;const currentVol=live&&liveDate===today?n(live.vol_hands)??n(live.vol):n(hist.at(-1)?.vol);
    return {ts_code:def.ts_code,name:def.name,style:def.style,current,source:live&&liveDate===today?idx.source:"Tushare index_daily",source_time:live&&liveDate===today?idx.source_time:(hist.at(-1)?.trade_date||null),freshness:live&&liveDate===today?"realtime":"completed_daily",pct_change:live&&liveDate===today?n(live.pct_change):n(hist.at(-1)?.pct_chg),high,low,intraday_close_position:dayPosition,technicals:tech,ma_distance_pct:{ma5:current!==null&&tech.ma5?(current/tech.ma5-1)*100:null,ma10:current!==null&&tech.ma10?(current/tech.ma10-1)*100:null,ma20:current!==null&&tech.ma20?(current/tech.ma20-1)*100:null,ma60:current!==null&&tech.ma60?(current/tech.ma60-1)*100:null},returns:{d5:returnFromRows(frame,5),d20:returnFromRows(frame,20)},volume:{current:currentVol,avg5,ratio_vs_5d:currentVol!==null&&avg5?currentVol/avg5:null},history_error:h.error};
  });
  const styleMap=Object.fromEntries(rows.map(r=>[r.name,r.pct_change]));
  return {rows,style_relative_strength:{growth_vs_large:(n(styleMap["创业板指"])!==null&&n(styleMap["沪深300"])!==null)?n(styleMap["创业板指"])!-n(styleMap["沪深300"])!:null,star_vs_large:(n(styleMap["科创50"])!==null&&n(styleMap["沪深300"])!==null)?n(styleMap["科创50"])!-n(styleMap["沪深300"])!:null,small_vs_large:(n(styleMap["中证1000"])!==null&&n(styleMap["沪深300"])!==null)?n(styleMap["中证1000"])!-n(styleMap["沪深300"])!:null},provider:idx.source,provider_error:idx.error};
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
  const idxMatrix=await indexMatrix(idx);
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
    indices:idx.rows,index_matrix:idxMatrix,
    breadth:{freshness:breadthMode,universe:eligible.length,advancers:pcts.filter(x=>x>0).length,decliners:pcts.filter(x=>x<0).length,flat:pcts.filter(x=>Math.abs(x)<1e-12).length,above_5pct:pcts.filter(x=>x>=5).length,below_minus_5pct:pcts.filter(x=>x<=-5).length,above_9_5pct:pcts.filter(x=>x>=9.5).length,below_minus_9_5pct:pcts.filter(x=>x<=-9.5).length,median_pct_change:numericMedian(pcts),total_turnover_yuan:amount},
    leaders:{freshness:leadersSource,top_gainers:topG,top_decliners:topD,top_turnover:topA},
    provider_errors:{realtime_market:live.provider_errors,realtime_indices:idx.error,post_close_fallback:fallbackError},sources:[live.source,idx.source,leadersSource].filter(Boolean)};
}

function industryProxy(rows:Row[], topN:number) {
  const groups=new Map<string,Row[]>();
  for(const r of rows){const industry=String(r.industry||"").trim();if(!industry||r.risk_name||n(r.pct_change)===null)continue;const xs=groups.get(industry)||[];xs.push(r);groups.set(industry,xs);}
  const sectors:Row[]=[];
  for(const [industry,xs] of groups){
    const pcts=xs.map(r=>n(r.pct_change)).filter((x):x is number=>x!==null);if(pcts.length<3)continue;
    const median=numericMedian(pcts),mean=pcts.reduce((a,b)=>a+b,0)/pcts.length,adv=pcts.filter(x=>x>0).length;
    sectors.push({ts_code:`IND:${industry}`,symbol:`IND:${industry}`,name:industry,pct_change:median,pct_chg:median,mean_pct_change:mean,median_pct_change:median,advancers:adv,decliners:pcts.filter(x=>x<0).length,advancer_ratio:adv/pcts.length,member_count:pcts.length,amount:xs.reduce((a,r)=>a+(n(r.amount)||0),0),provider:"tushare_stock_basic+realtime_member_proxy",proxy_method:"median member pct_change; not an official industry index"});
  }
  return sectors.sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)||(n(b.advancer_ratio)||0)-(n(a.advancer_ratio)||0)).slice(0,topN);
}

function compoundReturns(xs:number[],days:number){
  const a=xs.slice(-days);if(!a.length)return null;return (a.reduce((acc,x)=>acc*(1+x/100),1)-1)*100;
}

function inferMarketRegimeFromRows(rows:Row[]){
  const pcts=rows.filter(r=>!r.risk_name).map(r=>n(r.pct_change)).filter((x):x is number=>x!==null);
  return classifyRegime({advancers:pcts.filter(x=>x>0).length,decliners:pcts.filter(x=>x<0).length,medianPct:numericMedian(pcts),above5:pcts.filter(x=>x>=5).length,below5:pcts.filter(x=>x<=-5).length});
}

async function sectorEngineData(historySessions=10){
  const live=await preferredRealtimeMarketFull();let marketRows=[...live.rows],marketSource=live.source,coverage=live.coverage,tradeDate=await latestOpenDate(),fallbackError:string|null=null;
  if(!marketRows.length){const fb=await completedDailyMarketFallback();marketRows=fb.rows;tradeDate=fb.trade_date||tradeDate;marketSource="post_close_daily";coverage="full";fallbackError=fb.error;}
  const basic=await safeQuery("stock_basic",{list_status:"L"},"ts_code,name,industry,market,exchange,list_date");
  const meta=new Map(basic.rows.map(r=>[String(r.ts_code),r]));
  const enriched=marketRows.map(r=>({...meta.get(String(r.ts_code)),...r} as Row)).filter(r=>String(r.industry||"").trim());
  const dates=await recentOpenDates(Math.max(5,Math.min(12,historySessions+1)));
  const dailyResults=await Promise.all(dates.map(async d=>({date:d,result:await safeQuery("daily",{trade_date:d},"ts_code,trade_date,pct_chg,amount")})));
  const byIndustryDate=new Map<string,Map<string,{median:number|null;amount:number;members:number}>>();
  for(const {date,result} of dailyResults){
    const groups=new Map<string,Row[]>();
    for(const r of result.rows){const ind=String(meta.get(String(r.ts_code))?.industry||"").trim();if(!ind)continue;const xs=groups.get(ind)||[];xs.push(r);groups.set(ind,xs);}
    for(const [ind,xs] of groups){const p=xs.map(r=>n(r.pct_chg)).filter((x):x is number=>x!==null);if(!byIndustryDate.has(ind))byIndustryDate.set(ind,new Map());byIndustryDate.get(ind)!.set(date,{median:numericMedian(p),amount:xs.reduce((a,r)=>a+(n(r.amount)||0)*1000,0),members:p.length});}
  }
  const groups=new Map<string,Row[]>();for(const r of enriched){if(r.risk_name||n(r.pct_change)===null)continue;const ind=String(r.industry||"").trim();const xs=groups.get(ind)||[];xs.push(r);groups.set(ind,xs);}
  const totalAmount=enriched.reduce((a,r)=>a+(n(r.amount)||0),0);
  const raw:any[]=[];
  for(const [industry,xs] of groups){
    const pcts=xs.map(r=>n(r.pct_change)).filter((x):x is number=>x!==null);if(pcts.length<3)continue;
    const ret1=numericMedian(pcts);const dateMap=byIndustryDate.get(industry)||new Map();
    const priorSeries=[...dateMap.entries()].filter(([d])=>d!==tradeDate).sort((a,b)=>a[0].localeCompare(b[0])).map(([,v])=>v.median).filter((x):x is number=>x!==null);
    const series=[...priorSeries, ...(ret1!==null?[ret1]:[])];
    const amountNow=xs.reduce((a,r)=>a+(n(r.amount)||0),0);
    const priorAmounts=[...dateMap.entries()].filter(([d])=>d!==tradeDate).sort((a,b)=>a[0].localeCompare(b[0])).map(([,v])=>v.amount).filter(x=>x>0);
    const avg5Amount=strategyMedian(priorAmounts.slice(-5));
    const adv=pcts.filter(x=>x>0).length,nearHigh=xs.filter(r=>(n(r.distance_from_high_pct)||-99)>=-2).length;
    raw.push({industry,ts_code:`IND:${industry}`,member_count:pcts.length,return_1d_pct:ret1,return_3d_pct:compoundReturns(series,3),return_5d_pct:compoundReturns(series,5),return_10d_pct:compoundReturns(series,10),advancers:adv,decliners:pcts.filter(x=>x<0).length,advancer_ratio:adv/pcts.length,above_3pct_ratio:pcts.filter(x=>x>=3).length/pcts.length,above_5pct_ratio:pcts.filter(x=>x>=5).length/pcts.length,near_intraday_high_ratio:nearHigh/pcts.length,total_amount_yuan:amountNow,turnover_share:totalAmount?amountNow/totalAmount:null,turnover_ratio_vs_5d:avg5Amount?amountNow/avg5Amount:null,acceleration_pct_per_day:ret1!==null&&compoundReturns(series,5)!==null?ret1-compoundReturns(series,5)!/5:null,provider:"tushare_stock_basic+realtime_member_proxy"});
  }
  const vals=(k:string)=>raw.map(x=>n(x[k])).filter((v):v is number=>v!==null);
  const ret1s=vals("return_1d_pct"),advrs=vals("advancer_ratio"),nearhs=vals("near_intraday_high_ratio"),turns=vals("turnover_ratio_vs_5d"),accs=vals("acceleration_pct_per_day");
  const sectors=raw.map(x=>{
    const ret5=n(x.return_5d_pct),ret10=n(x.return_10d_pct),r1=n(x.return_1d_pct);
    const score=clamp(100*(0.26*pctRank(r1,ret1s)+0.24*pctRank(n(x.advancer_ratio),advrs)+0.16*pctRank(n(x.near_intraday_high_ratio),nearhs)+0.14*pctRank(n(x.turnover_ratio_vs_5d),turns)+0.20*pctRank(n(x.acceleration_pct_per_day),accs)));
    const extended=(ret5!==null&&ret5>=12)||(ret10!==null&&ret10>=20)||(r1!==null&&r1>=6);
    const status=extended?"EXTENDED":score>=75&&(r1??0)>0?"IGNITION":score>=62&&(n(x.return_3d_pct)??0)>0?"EXPANDING":(r1??0)<0&&n(x.advancer_ratio)!<0.4?"WEAK":"NEUTRAL";
    return {...x,ignition_score:score,status,breakout_readiness:status==="IGNITION"?"B1_candidates_priority":status==="EXPANDING"?"B1_or_B2":status==="EXTENDED"?"prefer_B2_do_not_chase":"selective"};
  }).sort((a,b)=>(n(b.ignition_score)||0)-(n(a.ignition_score)||0));
  return {as_of_cn:cnNow(),trade_date:tradeDate,market_source:marketSource,coverage,market_rows:enriched,sectors,sector_map:new Map(sectors.map(x=>[x.industry,x])),provider_errors:{market:live.provider_errors,stock_basic:basic.error,daily_history:dailyResults.map(x=>({trade_date:x.date,error:x.result.error})).filter(x=>x.error),fallback:fallbackError},notes:["Sector strength is a member-return proxy based on Tushare stock_basic industry labels, not an official Shenwan index return.","V3.2.2 ranks ignition using breadth, current return, acceleration, proximity to intraday highs and turnover expansion; EXTENDED sectors are deliberately penalized for chase risk."]};
}

async function marketSectors(url:URL){
  const topN=Math.max(10,Math.min(100,Number(url.searchParams.get("top_n")||100)));const h=Math.max(5,Math.min(10,Number(url.searchParams.get("history_sessions")||10)));
  const data=await sectorEngineData(h);
  return {as_of_cn:data.as_of_cn,trade_date:data.trade_date,data_mode:data.coverage==="full"?`full_market_${data.market_source}`:"partial",coverage:data.coverage,sectors:data.sectors.slice(0,topN),ranking_method:"ignition_score",provider_errors:data.provider_errors,notes:data.notes};
}

async function fetchBreakoutHistory(code:string,days=170){
  const {start,end}=dateRange(days);
  const [d,a]=await Promise.all([safeQuery("daily",{ts_code:code,start_date:start,end_date:end},"ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"),safeQuery("adj_factor",{ts_code:code,start_date:start,end_date:end},"ts_code,trade_date,adj_factor")]);
  return {rows:qfqDaily(d.rows,a.rows),errors:{daily:d.error,adj_factor:a.error}};
}

function breakoutPrefilter(rows:Row[],sectorMap:Map<string,any>,limit:number,minAmountYuan:number){
  const eligible=rows.filter(r=>!r.risk_name&&n(r.close)!==null&&n(r.pre_close)!==null&&(n(r.amount)||0)>=minAmountYuan&&(n(r.pct_change)||0)>-2.5&&(n(r.pct_change)||0)<12);
  const amounts=eligible.map(r=>Math.log10(Math.max(1,n(r.amount)||1))),pcts=eligible.map(r=>n(r.pct_change)||0),near=eligible.map(r=>n(r.distance_from_high_pct)||-10);
  const scored=eligible.map(r=>{const industry=String(r.industry||"");const sec=sectorMap.get(industry);const sectorScore=n(sec?.ignition_score)||50;const pct=n(r.pct_change)||0,dist=n(r.distance_from_high_pct)||-10,amt=Math.log10(Math.max(1,n(r.amount)||1));const pre=100*(0.26*pctRank(pct,pcts)+0.22*pctRank(amt,amounts)+0.18*pctRank(dist,near)+0.34*(sectorScore/100));return {...r,prefilter_score:pre,sector_ignition_score:sectorScore,sector_status:sec?.status||"UNKNOWN"} as Row;}).sort((a,b)=>(n(b.prefilter_score)||0)-(n(a.prefilter_score)||0));
  const chosen=new Map<string,Row>();
  const bySector=new Map<string,Row[]>();for(const r of scored){const ind=String(r.industry||"UNKNOWN");const xs=bySector.get(ind)||[];xs.push(r);bySector.set(ind,xs);}
  for(const xs of bySector.values()){const r=xs[0];if(r)chosen.set(String(r.ts_code),r);}
  for(const r of scored){if(chosen.size>=limit)break;chosen.set(String(r.ts_code),r);}
  return {eligible_count:eligible.length,rows:[...chosen.values()].sort((a,b)=>(n(b.prefilter_score)||0)-(n(a.prefilter_score)||0)).slice(0,limit)};
}

async function marketBreakouts(url:URL){
  const scanLimit=Math.max(20,Math.min(60,Number(url.searchParams.get("scan_limit")||36)));
  const topN=Math.max(5,Math.min(30,Number(url.searchParams.get("top_n")||15)));
  const minAmountM=Math.max(20,Number(url.searchParams.get("min_amount_million")||150));const minAmountYuan=minAmountM*1e6;
  const sectorData=await sectorEngineData(10);const marketRows=sectorData.market_rows;const regime=inferMarketRegimeFromRows(marketRows);
  const pre=breakoutPrefilter(marketRows,sectorData.sector_map,scanLimit,minAmountYuan);
  const results:any[]=[];const historyErrors:any[]=[];
  const concurrency=6;
  for(let i=0;i<pre.rows.length;i+=concurrency){
    const batch=pre.rows.slice(i,i+concurrency);
    const out=await Promise.all(batch.map(async live=>{
      const code=String(live.ts_code||"");const hist=await fetchBreakoutHistory(code,180);
      if(!hist.rows.length){historyErrors.push({ts_code:code,...hist.errors});return null;}
      const sector=sectorData.sector_map.get(String(live.industry||""));
      const a=analyzeBreakout({history:hist.rows,live,marketScore:regime.score,marketRegime:regime.regime as RegimeLabel,sectorScore:n(sector?.ignition_score)||50,sectorReturnPct:n(sector?.return_1d_pct),sectorStatus:String(sector?.status||"UNKNOWN"),minAmountYuan});
      return a?{...a,prefilter_score:n(live.prefilter_score),quote_source:sectorData.market_source}:null;
    }));
    results.push(...out.filter(Boolean));
  }
  const stageOrder:Record<string,number>={B1:0,B2:1,B0:2,WAIT:3,B3:4,FAILED:5};
  results.sort((a,b)=>(stageOrder[a.stage]??9)-(stageOrder[b.stage]??9)||(n(b.score)||0)-(n(a.score)||0));
  const actionable=results.filter(x=>["B0","B1","B2"].includes(x.stage)&&(n(x.score)||0)>=60).sort((a,b)=>(n(b.score)||0)-(n(a.score)||0)).slice(0,topN);
  const extended=results.filter(x=>x.stage==="B3").sort((a,b)=>(n(b.score)||0)-(n(a.score)||0)).slice(0,10);const failed=results.filter(x=>x.stage==="FAILED").slice(0,10);
  const counts:Record<string,number>={};for(const r of results)counts[r.stage]=(counts[r.stage]||0)+1;
  return {as_of_cn:cnNow(),trade_date:sectorData.trade_date,data_mode:`${sectorData.coverage}_market_prefilter_then_history_confirm`,coverage:{market_cross_section:sectorData.coverage,prefilter_universe:pre.eligible_count,historical_confirmed:results.length,scan_limit:scanLimit,semantics:"All A-shares enter the realtime/liquidity/sector prefilter; only the selected prefilter pool receives 180-day qfq history confirmation. This avoids falsely claiming a 60-day historical scan of every symbol."},
    strategy:{name:"启动突破",stages:{B0:"pre-breakout/compression near reference high",B1:"launch breakout",B2:"first retest after breakout",B3:"extended/do not chase",FAILED:"failed breakout",WAIT:"no setup"},market_regime:regime,ranking:"Breakout Score = market 15 + sector 20 + base 15 + breakout 20 + volume 10 + relative strength 10 + liquidity 10 - extension penalty"},
    sector_leaders:sectorData.sectors.slice(0,12),stage_counts:counts,actionable_candidates:actionable,extended_do_not_chase:extended,failed_breakouts:failed,all_confirmed:results.slice(0,Math.min(40,results.length)),
    evaluation_schema:{persist_externally:false,note:"Netlify functions are stateless. signal_record is emitted per candidate so a future database/log sink can evaluate signals.",horizons_days:[1,3,5,10],metrics:["forward_return","MFE","MAE","invalidation_hit"]},
    provider_errors:{...sectorData.provider_errors,history:historyErrors},notes:[...sectorData.notes,"B0/B1/B2 are the preferred lifecycle; B3 is explicitly a chase-risk state, not a recommendation.","Historical confirmation uses Tushare daily + adj_factor (qfq)."]};
}

async function marketScan(url: URL) {
  const sectorTop=Math.max(3,Math.min(15,Number(url.searchParams.get("sector_top_n")||8))),leaderN=Math.max(1,Math.min(8,Number(url.searchParams.get("leaders_per_sector")||4))),marketTop=Math.max(5,Math.min(30,Number(url.searchParams.get("market_top_n")||15))),minAmountM=Math.max(0,Number(url.searchParams.get("min_amount_million")||100));
  const [live,industriesR]=await Promise.all([preferredRealtimeMarketFull(),preferredIndustries(sectorTop)]);
  let eligible:Row[]=live.rows.filter(r=>!r.risk_name&&n(r.close)!==null),topG:Row[]=[],topA:Row[]=[],candidates:Row[]=[],marketSource=live.source,marketCoverage=live.coverage;
  let industryRows=[...industriesR.rows],industrySource=industriesR.source,industryError=industriesR.error,industryMemberRows=live.rows;
  if(!industryRows.length&&live.rows.length){
    let enriched=live.rows;
    if(enriched.filter(r=>String(r.industry||"").trim()).length<Math.max(10,enriched.length*0.5)){
      const basic=await safeQuery("stock_basic",{list_status:"L"},"ts_code,name,industry");const meta=new Map(basic.rows.map(r=>[String(r.ts_code),r]));enriched=live.rows.map(r=>({...meta.get(String(r.ts_code)),...r} as Row));industryError=[industryError,basic.error].filter(Boolean).join("; ")||null;
    }
    industryMemberRows=enriched;industryRows=industryProxy(enriched,sectorTop);
    if(industryRows.length)industrySource="tushare_stock_basic+realtime_member_proxy";
  }
  if(eligible.length){const liquid=eligible.filter(r=>(n(r.amount)||0)>=minAmountM*1e6);topG=topRows(eligible,"pct_change",marketTop);topA=topRows(eligible,"amount",marketTop);candidates=liquid.filter(r=>(n(r.pct_change)||0)>0&&(n(r.distance_from_high_pct)||-99)>=-2).sort((a,b)=>(n(b.pct_change)||0)-(n(a.pct_change)||0)||(n(b.amount)||0)-(n(a.amount)||0)).slice(0,marketTop);}
  else{const [g,a]=await Promise.all([eastmoneyMarketRank("pct_change",true,100),eastmoneyMarketRank("amount",true,100)]);const gf=g.ok&&realtimeSourceFreshness(g.source_time).ok,af=a.ok&&realtimeSourceFreshness(a.source_time).ok;topG=gf?g.data.slice(0,marketTop):[];topA=af?a.data.slice(0,marketTop):[];const union=new Map<string,Row>();[...(gf?g.data:[]),...(af?a.data:[])].forEach(r=>union.set(String(r.ts_code),r));eligible=[...union.values()].filter(r=>!r.risk_name);candidates=eligible.filter(r=>(n(r.amount)||0)>=minAmountM*1e6&&(n(r.pct_change)||0)>0&&(n(r.distance_from_high_pct)||-99)>=-2).sort((a,b)=>(n(b.pct_change)||0)-(n(a.pct_change)||0)||(n(b.amount)||0)-(n(a.amount)||0)).slice(0,marketTop);marketSource=(gf||af)?"eastmoney_ranked":null;marketCoverage="ranked_partial";}
  const industryLeaders:Row[]=[];
  for(const sector of industryRows){
    if(industrySource==="tushare_stock_basic+realtime_member_proxy"){
      const name=String(sector.name||"");const members=industryMemberRows.filter(r=>String(r.industry||"")===name&&!r.risk_name);
      industryLeaders.push({sector_code:sector.ts_code,sector_name:name,sector_pct_change:sector.pct_change,sector_mean_pct_change:sector.mean_pct_change,sector_advancer_ratio:sector.advancer_ratio,leaders:members.sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,leaderN),quote_source:live.source,quote_error:null,proxy_note:"Industry strength is a member-return proxy, not an official index return."});
    } else if(industrySource==="tushare_rt_sw_k"){
      const code=s(sector.ts_code);if(!code)continue;const membersR=await safeQuery("index_member_all",{l1_code:code,is_new:"Y"},"l1_code,l1_name,ts_code,name,is_new");const codes=membersR.rows.map(r=>s(r.ts_code)).filter((x):x is string=>!!x);const quotes=await preferredQuotesForCodes(codes);industryLeaders.push({sector_code:code,sector_name:sector.name,sector_pct_change:sector.pct_change,leaders:quotes.rows.filter(r=>!r.risk_name).sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,leaderN),member_error:membersR.error,quote_error:quotes.error,quote_source:quotes.source});
    } else {
      const boardCode=s(sector.symbol)||s(sector.ts_code);if(!boardCode)continue;const members=await eastmoneyBoardMembers(boardCode,300);industryLeaders.push({sector_code:boardCode,sector_name:sector.name,sector_pct_change:sector.pct_change,leaders:members.data.filter(r=>!r.risk_name).sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0,leaderN),quote_source:"eastmoney_board_members",quote_error:members.error});
    }
  }
  return {as_of_cn:cnNow(),data_mode:marketCoverage==="full"?`realtime_full_${marketSource}`:marketSource?"realtime_ranked_partial":"post_close_only",coverage:marketCoverage,
    freshness_note:marketCoverage==="full"?"Full realtime market cross-section available.":marketSource?"Realtime ranked lists are available, but this is not a complete all-stock universe; candidate scan coverage is partial.":"No realtime provider available.",
    filters:{min_amount_million:minAmountM,momentum_candidate_rule:"positive pct_change; within 2% of intraday high; turnover amount above threshold; excludes ST/退 names"},
    strongest_industries:industryRows,industry_source:industrySource,industry_leaders:industryLeaders,top_gainers:topG,top_turnover:topA,liquid_momentum_candidates:candidates,
    provider_errors:{market:live.provider_errors,industry:industryError},sources:[marketSource,industrySource].filter(Boolean),
    notes:[industrySource==="tushare_stock_basic+realtime_member_proxy"?"Industry ranking is a proxy based on the median realtime return of Tushare stock_basic industry members; it is not an official Shenwan index return.":null].filter(Boolean)};
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
  const regime=classifyRegime({advancers:pcts.filter(x=>x>0).length,decliners:pcts.filter(x=>x<0).length,medianPct:numericMedian(pcts),above5:pcts.filter(x=>x>=5).length,below5:pcts.filter(x=>x<=-5).length,sealedUp:sealedUp.length,opened:openedBoard.length,sealedDown:sealedDown.length});
  return {as_of_cn:cnNow(),data_mode:mode,coverage,count_semantics:coverage==="full"?"whole_market":"observed_lower_bound",freshness_note:mode.startsWith("realtime")?"Board status computed from available realtime quotes versus official Tushare limit prices.":`Board status reconstructed from completed daily data for ${tradeDate}.`,trade_date:tradeDate,regime,
    realtime_temperature:{sealed_limit_up_count:sealedUp.length,opened_limit_up_board_count:openedBoard.length,sealed_limit_down_count:sealedDown.length,above_5pct_count:pcts.filter(x=>x>=5).length,below_minus_5pct_count:pcts.filter(x=>x<=-5).length,advancers:pcts.filter(x=>x>0).length,decliners:pcts.filter(x=>x<0).length,max_estimated_streak:maxStreak,estimated_streak_ladder:ladder},sealed_limit_up:sortNumeric(sealedUp,"estimated_streak",true).slice(0,40),opened_boards:sortNumeric(openedBoard,"pct_change",true).slice(0,30),sealed_limit_down:sortNumeric(sealedDown,"pct_change",false).slice(0,30),previous_trade_date:prevDate,previous_day_strong_themes:sortNumeric(strongR.rows,"rank",false).slice(0,12),provider_board_lists:{freshness:"kpl_provider_trade_date_when_available",limit_up:kplUpR.rows.slice(0,80),opened_board:kplBreakR.rows.slice(0,80),limit_down:kplDownR.rows.slice(0,80),auction:kplAuctionR.rows.slice(0,80)},
    permission_errors:{rt_k:full.provider_errors.tushare,stk_limit:limitsR.error,previous_limit_step:prevStepR.error,previous_limit_cpt_list:strongR.error,kpl_limit_up:kplUpR.error,kpl_opened_board:kplBreakR.error,kpl_limit_down:kplDownR.error,kpl_auction:kplAuctionR.error},provider_errors:{eastmoney:full.provider_errors.eastmoney},sources:[full.source||mode,"Tushare stk_limit","Tushare limit_step","Tushare limit_cpt_list","Tushare kpl_list"],notes:[partialWarning,"Tushare realtime is always preferred. Free realtime providers are only fallbacks.","If realtime coverage is partial, counts are explicitly labeled lower bounds rather than whole-market totals.","estimated_streak uses Tushare limit_step when available; without that permission it should not be treated as an authoritative streak count."].filter(Boolean)};
}

async function providerDiagnostics(url:URL){
  const code=normalizeCode(url.searchParams.get("ts_code")||"600522.SH"),freq=(url.searchParams.get("freq")||"5MIN").toUpperCase();
  const [trQ,trM,txQ,emQ,siQ,emM,siM,emRank,emInd]=await Promise.all([safeQuery("rt_k",{ts_code:code}),safeQuery("rt_min_daily",{ts_code:code,freq}),tencentQuote(code),eastmoneyQuote(code),sinaQuote(code),eastmoneyMinutes(code,freq),sinaMinutes(code,freq),eastmoneyMarketRank("pct_change",true,5),eastmoneyBoards("industry",10)]);
  const tr=normalizeTushareRealtimeQuote(trQ.rows.at(0)||null),primary=tr||txQ.data||emQ.data||siQ.data||null;const checks:Array<{source:string;row:Row|null;source_time?:string|null}>=[];
  if(primary!==txQ.data&&txQ.data)checks.push({source:"tencent",row:txQ.data,source_time:txQ.source_time});
  if(primary!==emQ.data&&emQ.data)checks.push({source:"eastmoney",row:emQ.data,source_time:emQ.source_time});
  if(primary!==siQ.data&&siQ.data)checks.push({source:"sina",row:siQ.data,source_time:siQ.source_time});
  return {as_of_cn:cnNow(),ts_code:code,quote_consensus:quoteConsensus(primary,checks),providers:{tushare_rt_k:{ok:!!tr,error:trQ.error,row:tr},tushare_rt_min_daily:{ok:!!trM.rows.length,error:trM.error,last_bar:trM.rows.at(-1)||null},tencent_quote:{ok:txQ.ok,error:txQ.error,source_time:txQ.source_time,latency_ms:txQ.latency_ms,row:txQ.data},eastmoney_quote:{ok:emQ.ok,error:emQ.error,source_time:emQ.source_time,latency_ms:emQ.latency_ms,row:emQ.data},sina_quote:{ok:siQ.ok,error:siQ.error,source_time:siQ.source_time,latency_ms:siQ.latency_ms,row:siQ.data},eastmoney_minute:{ok:emM.ok,error:emM.error,source_time:emM.source_time,latency_ms:emM.latency_ms,last_bar:emM.data.at(-1)||null},sina_minute:{ok:siM.ok,error:siM.error,source_time:siM.source_time,latency_ms:siM.latency_ms,last_bar:siM.data.at(-1)||null},eastmoney_market_rank:{ok:emRank.ok,error:emRank.error,latency_ms:emRank.latency_ms,rows:emRank.data.length},eastmoney_industry:{ok:emInd.ok,error:emInd.error,latency_ms:emInd.latency_ms,rows:emInd.data.length}},notes:["Tencent is used as an independent realtime quote cross-check and as a whole-market fallback only when measured symbol coverage is high enough.","Use this endpoint after deployment to verify which providers are reachable from the Netlify egress IP.","A provider marked ok does not by itself prove independent accuracy; quote_consensus compares returned prices when multiple sources are available."]};
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
    if (path === "/market/sectors") return json(await marketSectors(url));
    if (path === "/market/breakouts") return json(await marketBreakouts(url));
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
    "/market/sectors",
    "/market/breakouts",
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
