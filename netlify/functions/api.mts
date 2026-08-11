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

const VERSION = "3.1.1";
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
    service: "tushare-chatgpt-bridge-v3.1.1-netlify",
    version: VERSION,
    as_of_cn: cnNow(),
    read_only: true,
    endpoints: ["market/overview", "market/scan", "market/themes", "market/sentiment", "stock/snapshot", "stock/context", "stock/intraday", "stock/lhb", "stock/risk-events"],
  };
}

async function stockIntraday(code: string, url: URL) {
  const freq = (url.searchParams.get("freq") || "5MIN").toUpperCase();
  if (!["1MIN","5MIN","15MIN","30MIN","60MIN"].includes(freq)) throw new Error("freq must be 1MIN/5MIN/15MIN/30MIN/60MIN");
  const rows = await tushareQuery("rt_min_daily", { ts_code: code, freq });
  rows.sort((a,b)=>String(a.time).localeCompare(String(b.time)));
  return { as_of_cn: cnNow(), ts_code: code, freq, source: "Tushare rt_min_daily", rows };
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

  const [basicR, dailyR, adjR, rtR, minR, flowR, dailyBasicR, marginR, cyqR, kplR] = await Promise.all([
    safeQuery("stock_basic", { ts_code: code, list_status: "L" }, "ts_code,symbol,name,area,industry,market,exchange,list_date"),
    safeQuery("daily", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount"),
    safeQuery("adj_factor", { ts_code: code, start_date: start, end_date: end }, "ts_code,trade_date,adj_factor"),
    safeQuery("rt_k", { ts_code: code }),
    safeQuery("rt_min_daily", { ts_code: code, freq }),
    safeQuery("moneyflow_ths", { ts_code: code, start_date: start, end_date: end }),
    safeQuery("daily_basic", { ts_code: code, start_date: start, end_date: end }, DAILY_BASIC_FIELDS),
    safeQuery("margin_detail", { ts_code: code, start_date: start, end_date: end }, MARGIN_FIELDS),
    safeQuery("cyq_perf", { ts_code: code, start_date: start, end_date: end }, CYQ_FIELDS),
    safeQuery("kpl_list", { ts_code: code, start_date: start, end_date: end }, KPL_FIELDS),
  ]);

  if (!dailyR.rows.length) throw new Error("No daily history returned for this code");
  const hist = qfqDaily(dailyR.rows, adjR.rows).slice(-days);
  const latestHist = hist.at(-1)!;
  const rt = enrichRealtime(rtR.rows).at(0) || null;
  const minute = [...minR.rows].sort((a,b)=>String(a.time).localeCompare(String(b.time)));

  const frame = [...hist];
  if (rt) {
    const today = dateCompact(new Date());
    const histDate = String(latestHist.trade_date || "");
    if (today !== histDate) {
      frame.push({
        ts_code: code,
        trade_date: today,
        open: rt.open,
        high: rt.high,
        low: rt.low,
        close: rt.close,
        // Tushare daily vol is in lots (hands); rt_k vol is shares.
        vol: n(rt.vol) !== null ? n(rt.vol)! / 100 : null,
        // Daily amount is typically thousand yuan; keep appended scale comparable.
        amount: n(rt.amount) !== null ? n(rt.amount)! / 1000 : null,
      });
    }
  }
  const tech = indicators(frame);

  const currentClose = rt ? n(rt.close) : n(latestHist.close);
  const prevClose = rt ? n(rt.pre_close) : n(latestHist.pre_close);
  const avg5VolHands = hist.slice(-5).map(r=>n(r.vol)).filter((x):x is number=>x!==null);
  const avg5 = avg5VolHands.length ? avg5VolHands.reduce((a,b)=>a+b,0)/avg5VolHands.length : null;
  const progress = rt ? chinaTradingProgress() : null;
  // Never use a completed prior-day daily volume as if it were today's intraday volume.
  const currentVolHands = rt && n(rt.vol) !== null ? n(rt.vol)! / 100 : null;
  const latestCompletedDailyVolHands = n(latestHist.vol);
  const projected = currentVolHands !== null && progress !== null && progress > 0 ? currentVolHands / progress : null;
  const recent20 = frame.slice(-20);
  const highs20 = recent20.map(r=>n(r.high)).filter((x):x is number=>x!==null);
  const lows20 = recent20.map(r=>n(r.low)).filter((x):x is number=>x!==null);

  const latestFlow = latestRow(flowR.rows);
  const latestDailyBasic = latestRow(dailyBasicR.rows);
  const latestMargin = latestRow(marginR.rows);
  const latestCyq = latestRow(cyqR.rows);
  const recentKpl = [...kplR.rows].sort((a,b)=>String(b.trade_date || "").localeCompare(String(a.trade_date || ""))).slice(0, 10);
  const maDistances: Record<string, number | null> = {};
  for (const key of ["ma5","ma10","ma20","ma60"] as const) {
    const ma = tech[key];
    maDistances[`${key}_distance_pct`] = currentClose !== null && ma ? (currentClose / ma - 1) * 100 : null;
  }

  return {
    as_of_cn: cnNow(),
    market_trade_time: rt ? s(rt.trade_time) : null,
    data_mode: rt ? "realtime" : "latest_completed_daily_fallback",
    quote_freshness: rt ? "realtime_rt_k" : `daily_close_${String(latestHist.trade_date || "unknown")}`,
    info: basicR.rows.at(0) || { ts_code: code },
    quote: rt || latestHist,
    price_context: {
      current: currentClose,
      previous_close: prevClose,
      pct_from_previous_close: currentClose !== null && prevClose ? (currentClose / prevClose - 1) * 100 : null,
      ...maDistances,
      recent_20d_high: highs20.length ? Math.max(...highs20) : null,
      recent_20d_low: lows20.length ? Math.min(...lows20) : null,
    },
    technicals: tech,
    volume: {
      realtime_available: !!rt,
      current_volume_hands: currentVolHands,
      latest_completed_daily_volume_hands: latestCompletedDailyVolHands,
      avg5_daily_volume_hands: avg5,
      trading_session_progress: progress,
      projected_full_day_volume_hands: projected,
      projected_volume_vs_5d_avg: projected !== null && avg5 ? projected / avg5 : null,
      note: rt ? "Realtime volume pace from rt_k." : "Realtime quote unavailable; projected intraday volume fields are intentionally null.",
    },
    intraday: {
      available: !!minute.length,
      freq,
      bars: minute.length,
      first_bar: minute.at(0) || null,
      last_bar: minute.at(-1) || null,
      error: minR.error,
    },
    latest_moneyflow: latestFlow,
    moneyflow_freshness: latestFlow ? "post_close" : null,
    daily_basic: latestDailyBasic,
    daily_basic_freshness: latestDailyBasic ? "post_close_15_17_cn" : null,
    margin: latestMargin,
    margin_freshness: latestMargin ? "exchange_previous_day_update_around_08_30_cn" : null,
    chip_cost: latestCyq,
    chip_cost_freshness: latestCyq ? "post_close_18_19_cn_model_estimate" : null,
    recent_limit_board_history: recentKpl,
    permission_errors: {
      realtime_quote: rtR.error,
      realtime_minute: minR.error,
      moneyflow_ths: flowR.error,
      stock_basic: basicR.error,
      daily_basic: dailyBasicR.error,
      margin_detail: marginR.error,
      cyq_perf: cyqR.error,
      kpl_list: kplR.error,
    },
    sources: ["daily", "adj_factor", rt ? "rt_k" : null, minute.length ? "rt_min_daily" : null, latestFlow ? "moneyflow_ths" : null, latestDailyBasic ? "daily_basic" : null, latestMargin ? "margin_detail" : null, latestCyq ? "cyq_perf" : null, recentKpl.length ? "kpl_list" : null].filter(Boolean),
    notes: [
      "Daily technicals are calculated on qfq prices anchored to the latest available adjustment factor.",
      "Realtime volume is converted from shares to hands before comparison with daily volume.",
      "Money-flow and daily_basic are post-close and must not be interpreted as realtime.",
      "margin_detail reflects exchange financing/securities-lending detail and is normally updated for the prior trading day the next morning.",
      "cyq_perf is a Tushare community model estimate of chip-cost distribution, not account-level exchange holdings.",
    ],
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
      const rows = r.rows.map(x => ({
        ...x,
        pct_change: n(x.pct_chg),
        // daily.amount is thousand yuan; normalize to yuan to match rt_k semantics.
        amount: n(x.amount) !== null ? n(x.amount)! * 1000 : null,
        risk_name: false,
      }));
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
  let market: Row[] = [];
  let mode: "realtime" | "post_close_fallback" = "realtime";
  let dataTradeDate: string | null = null;
  let realtimeError: string | null = null;
  try {
    market = await realtimeMarket();
    dataTradeDate = await latestOpenDate();
  } catch (e) {
    realtimeError = e instanceof Error ? e.message : String(e);
    const fb = await completedDailyMarketFallback();
    market = fb.rows;
    dataTradeDate = fb.trade_date;
    mode = "post_close_fallback";
  }

  const idxR = mode === "realtime"
    ? await safeQuery("rt_idx_k", { ts_code: "000001.SH,399001.SZ,399006.SZ,000300.SH" })
    : { rows: [] as Row[], error: "Realtime indices skipped because rt_k is unavailable." };

  const eligible = market.filter(r => !r.risk_name && n(r.close) !== null && n(r.pre_close) !== null);
  const pcts = eligible.map(r=>n(r.pct_change)).filter((x):x is number=>x!==null);
  const amount = eligible.reduce((acc,r)=>acc+(n(r.amount)||0),0);
  return {
    as_of_cn: cnNow(),
    data_mode: mode,
    data_trade_date: dataTradeDate,
    freshness_note: mode === "realtime"
      ? "Live market cross-section from rt_k."
      : "rt_k unavailable; figures are from the latest completed daily market snapshot and are not current intraday data.",
    market_trade_time: mode === "realtime" ? marketTradeTime(market) : null,
    indices: enrichRealtime(idxR.rows),
    breadth: {
      universe: eligible.length,
      advancers: pcts.filter(x=>x>0).length,
      decliners: pcts.filter(x=>x<0).length,
      flat: pcts.filter(x=>Math.abs(x)<1e-12).length,
      above_5pct: pcts.filter(x=>x>=5).length,
      below_minus_5pct: pcts.filter(x=>x<=-5).length,
      above_9_5pct: pcts.filter(x=>x>=9.5).length,
      below_minus_9_5pct: pcts.filter(x=>x<=-9.5).length,
      median_pct_change: numericMedian(pcts),
      total_turnover_yuan: amount,
    },
    leaders: {
      top_gainers: topRows(eligible, "pct_change", 12),
      top_decliners: topRows(eligible, "pct_change", 12, false),
      top_turnover: topRows(eligible, "amount", 12),
    },
    permission_errors: { realtime_market: realtimeError, realtime_indices: idxR.error },
    sources: mode === "realtime" ? ["Tushare rt_k", "Tushare rt_idx_k"] : ["Tushare daily (fallback)"],
  };
}

async function marketScan(url: URL) {
  const sectorTop = Math.max(3, Math.min(15, Number(url.searchParams.get("sector_top_n") || 8)));
  const leaderN = Math.max(1, Math.min(8, Number(url.searchParams.get("leaders_per_sector") || 4)));
  const marketTop = Math.max(5, Math.min(30, Number(url.searchParams.get("market_top_n") || 15)));
  const minAmountM = Math.max(0, Number(url.searchParams.get("min_amount_million") || 100));
  let market: Row[] = [];
  let marketMode: "realtime" | "post_close_fallback" = "realtime";
  let marketRealtimeError: string | null = null;
  try { market = await realtimeMarket(); }
  catch (e) {
    marketRealtimeError = e instanceof Error ? e.message : String(e);
    const fb = await completedDailyMarketFallback();
    market = fb.rows;
    marketMode = "post_close_fallback";
  }
  const swR = marketMode === "realtime" ? await safeQuery("rt_sw_k", {}) : { rows: [] as Row[], error: "Realtime industries skipped because rt_k is unavailable." };
  const eligible = market.filter(r => !r.risk_name && n(r.close) !== null && n(r.pre_close) !== null);
  const liquid = eligible.filter(r => (n(r.amount)||0) >= minAmountM * 1e6);
  const candidates = liquid.filter(r => (n(r.pct_change)||0)>0 && (n(r.distance_from_high_pct)||-99)>=-2)
    .sort((a,b)=>(n(b.pct_change)||0)-(n(a.pct_change)||0) || (n(b.amount)||0)-(n(a.amount)||0)).slice(0, marketTop);

  let industries = enrichRealtime(swR.rows);
  // rt_sw_k normally already includes pct_change; preserve it if present.
  industries = industries.sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0, sectorTop);
  const industryLeaders: Row[] = [];
  for (const sector of industries) {
    const code = s(sector.ts_code);
    if (!code) continue;
    const membersR = await safeQuery("index_member_all", { l1_code: code, is_new: "Y" }, "l1_code,l1_name,ts_code,name,is_new");
    const codes = membersR.rows.map(r=>s(r.ts_code)).filter((x):x is string=>!!x);
    let quotes: Row[] = [];
    let quoteError: string | null = null;
    try { quotes = await realtimeForCodes(codes); } catch(e) { quoteError = e instanceof Error ? e.message : String(e); }
    quotes = quotes.filter(r=>!r.risk_name).sort((a,b)=>(n(b.pct_change)||-999)-(n(a.pct_change)||-999)).slice(0, leaderN);
    industryLeaders.push({
      sector_code: code,
      sector_name: sector.name,
      sector_pct_change: sector.pct_change,
      leaders: quotes,
      member_error: membersR.error,
      quote_error: quoteError,
    });
  }

  return {
    as_of_cn: cnNow(),
    data_mode: marketMode,
    freshness_note: marketMode === "realtime" ? "Live scan from rt_k." : "rt_k unavailable; market leaders are from the latest completed daily snapshot; realtime industry ranking is unavailable.",
    market_trade_time: marketMode === "realtime" ? marketTradeTime(market) : null,
    filters: {
      min_amount_million: minAmountM,
      momentum_candidate_rule: "positive pct_change; within 2% of intraday high; turnover amount above threshold; excludes ST/退 names",
    },
    strongest_sw_industries: industries,
    industry_leaders: industryLeaders,
    top_gainers: topRows(eligible, "pct_change", marketTop),
    top_turnover: topRows(eligible, "amount", marketTop),
    liquid_momentum_candidates: candidates,
    permission_errors: { rt_k: marketRealtimeError, rt_sw_k: swR.error },
    sources: marketMode === "realtime" ? ["Tushare rt_k", "Tushare rt_sw_k", "Tushare index_member_all"] : ["Tushare daily (fallback)"],
  };
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
  const code = s(theme.ts_code)!;
  const membersR = await safeQuery("ths_member", { ts_code: code });
  const codes = membersR.rows.map(r=>s(r.con_code)).filter((x):x is string=>!!x);
  let quotes: Row[] = [];
  let quoteError: string | null = null;
  try { quotes = await realtimeForCodes(codes); } catch(e) { quoteError = e instanceof Error ? e.message : String(e); }
  quotes = quotes.filter(r=>!r.risk_name);
  return {
    ts_code: code,
    name: theme.name,
    ths_member_count: codes.length,
    realtime: summarizeThemeQuotes(quotes, leaders),
    errors: { members: membersR.error, realtime_quotes: quoteError },
  };
}

async function marketThemes(url: URL) {
  const q = (url.searchParams.get("q") || "").trim();
  const topN = Math.max(3, Math.min(15, Number(url.searchParams.get("top_n") || 8)));
  const leaders = Math.max(3, Math.min(10, Number(url.searchParams.get("leaders") || 5)));
  const openDate = await latestOpenDate();
  const [strong, flow] = await Promise.all([
    latestAvailable("limit_cpt_list", openDate),
    latestAvailable("moneyflow_cnt_ths", openDate),
  ]);
  const postCloseStrong = sortNumeric(strong.rows, "rank", false).slice(0, topN);
  const postCloseFlow = sortNumeric(flow.rows, "net_amount", true).slice(0, topN);

  let matched: Row[] = [];
  let evaluated: unknown[] = [];
  let searchError: string | null = null;
  if (q) {
    const idxR = await safeQuery("ths_index", { exchange: "A", type: "N" });
    searchError = idxR.error;
    const terms = q.split(/[,，]/).map(x=>x.trim().toLowerCase()).filter(Boolean);
    matched = idxR.rows.filter(r => terms.some(t => String(r.name||"").toLowerCase().includes(t))).slice(0, 6);
    evaluated = await Promise.all(matched.map(t => evaluateTheme(t, leaders)));
  }

  return {
    as_of_cn: cnNow(),
    query: q || null,
    realtime_theme_evaluation: evaluated,
    matched_theme_definitions: matched,
    latest_strong_theme_board: {
      freshness: "post_close",
      trade_date: strong.trade_date,
      rows: postCloseStrong,
      error: strong.error,
    },
    latest_theme_moneyflow: {
      freshness: "post_close",
      trade_date: flow.trade_date,
      rows: postCloseFlow,
      error: flow.error,
    },
    search_error: searchError,
    sources: ["Tushare ths_index", "Tushare ths_member", "Tushare rt_k", "Tushare limit_cpt_list", "Tushare moneyflow_cnt_ths"],
    notes: [
      "When q is provided, matching THS concept members are evaluated against current rt_k quotes.",
      "Strong-theme board and concept money-flow datasets are post-close and are explicitly dated.",
    ],
  };
}

async function marketSentiment() {
  let market: Row[] = [];
  let mode: "realtime" | "post_close_fallback" = "realtime";
  let tradeDate = await latestOpenDate();
  let realtimeError: string | null = null;
  try {
    market = await realtimeMarket();
  } catch (e) {
    realtimeError = e instanceof Error ? e.message : String(e);
    const fb = await completedDailyMarketFallback();
    market = fb.rows;
    tradeDate = fb.trade_date || tradeDate;
    mode = "post_close_fallback";
  }

  const prevDate = await previousOpenDate(tradeDate);
  const [limitsR, prevStepR, strongR, kplUpR, kplBreakR, kplDownR, kplAuctionR] = await Promise.all([
    safeQuery("stk_limit", { trade_date: tradeDate }, "trade_date,ts_code,pre_close,up_limit,down_limit"),
    prevDate ? safeQuery("limit_step", { trade_date: prevDate }) : Promise.resolve({ rows: [] as Row[], error: null as string|null }),
    prevDate ? safeQuery("limit_cpt_list", { trade_date: prevDate }) : Promise.resolve({ rows: [] as Row[], error: null as string|null }),
    safeQuery("kpl_list", { trade_date: tradeDate, tag: "涨停" }, KPL_FIELDS),
    safeQuery("kpl_list", { trade_date: tradeDate, tag: "炸板" }, KPL_FIELDS),
    safeQuery("kpl_list", { trade_date: tradeDate, tag: "跌停" }, KPL_FIELDS),
    safeQuery("kpl_list", { trade_date: tradeDate, tag: "竞价" }, KPL_FIELDS),
  ]);

  const lmap = new Map(limitsR.rows.map(r=>[String(r.ts_code), r]));
  const kplMap = new Map([...kplUpR.rows, ...kplBreakR.rows, ...kplDownR.rows].map(r=>[String(r.ts_code), r]));
  const prevStreak = new Map(prevStepR.rows.map(r=>[String(r.ts_code), Number(r.nums)||1]));
  const sealedUp: Row[] = [], openedBoard: Row[] = [], sealedDown: Row[] = [];

  for (const row of market) {
    if (row.risk_name) continue;
    const lim = lmap.get(String(row.ts_code));
    if (!lim) continue;
    const close=n(row.close), high=n(row.high), up=n(lim.up_limit), down=n(lim.down_limit);
    if (close===null || up===null || down===null) continue;
    const eps = Math.max(0.001, close * 0.00005);
    const hitUp = high !== null && high >= up - eps;
    const isUp = close >= up - eps;
    const isDown = close <= down + eps;
    if (isUp) sealedUp.push({ ...row, up_limit: up, estimated_streak: (prevStreak.get(String(row.ts_code)) || 0) + 1, kpl: kplMap.get(String(row.ts_code)) || null });
    else if (hitUp) openedBoard.push({ ...row, up_limit: up, kpl: kplMap.get(String(row.ts_code)) || null });
    if (isDown) sealedDown.push({ ...row, down_limit: down, kpl: kplMap.get(String(row.ts_code)) || null });
  }

  const ladder: Record<string, number> = {};
  for (const r of sealedUp) {
    const k = String(r.estimated_streak || 1);
    ladder[k] = (ladder[k] || 0) + 1;
  }
  const pcts = market.filter(r=>!r.risk_name).map(r=>n(r.pct_change)).filter((x):x is number=>x!==null);
  const maxStreak = sealedUp.reduce((m,r)=>Math.max(m, Number(r.estimated_streak)||1), 0);

  return {
    as_of_cn: cnNow(),
    data_mode: mode,
    freshness_note: mode === "realtime"
      ? "Current board status computed from rt_k versus official limit prices."
      : `rt_k unavailable; board status is reconstructed from completed daily data for ${tradeDate}, not current intraday sentiment.`,
    market_trade_time: mode === "realtime" ? marketTradeTime(market) : null,
    trade_date: tradeDate,
    realtime_temperature: {
      sealed_limit_up_count: sealedUp.length,
      opened_limit_up_board_count: openedBoard.length,
      sealed_limit_down_count: sealedDown.length,
      above_5pct_count: pcts.filter(x=>x>=5).length,
      below_minus_5pct_count: pcts.filter(x=>x<=-5).length,
      advancers: pcts.filter(x=>x>0).length,
      decliners: pcts.filter(x=>x<0).length,
      max_estimated_streak: maxStreak,
      estimated_streak_ladder: ladder,
    },
    sealed_limit_up: sortNumeric(sealedUp, "estimated_streak", true).slice(0, 40),
    opened_boards: sortNumeric(openedBoard, "pct_change", true).slice(0, 30),
    sealed_limit_down: sortNumeric(sealedDown, "pct_change", false).slice(0, 30),
    previous_trade_date: prevDate,
    previous_day_strong_themes: sortNumeric(strongR.rows, "rank", false).slice(0, 12),
    provider_board_lists: {
      freshness: "kpl_provider_trade_date_when_available",
      limit_up: kplUpR.rows.slice(0, 80),
      opened_board: kplBreakR.rows.slice(0, 80),
      limit_down: kplDownR.rows.slice(0, 80),
      auction: kplAuctionR.rows.slice(0, 80),
    },
    permission_errors: {
      rt_k: realtimeError,
      stk_limit: limitsR.error,
      previous_limit_step: prevStepR.error,
      previous_limit_cpt_list: strongR.error,
      kpl_limit_up: kplUpR.error,
      kpl_opened_board: kplBreakR.error,
      kpl_limit_down: kplDownR.error,
      kpl_auction: kplAuctionR.error,
    },
    sources: mode === "realtime"
      ? ["Tushare rt_k", "Tushare stk_limit", "Tushare limit_step", "Tushare limit_cpt_list", "Tushare kpl_list"]
      : ["Tushare daily (fallback)", "Tushare stk_limit", "Tushare limit_step", "Tushare limit_cpt_list", "Tushare kpl_list"],
    notes: [
      "Current sealed/failed boards are computed from realtime price/high versus today's official limit prices when rt_k is available.",
      "Without rt_k, the same logic is reconstructed only for the latest completed daily session and must not be interpreted as live sentiment.",
      "estimated_streak is inferred from the previous trading day's limit_step plus the evaluated session's sealed board; treat it as an estimate, not an exchange field.",
    ],
  };
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
