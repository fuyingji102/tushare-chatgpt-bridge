import type { Row } from "./tushare.js";
import { n, s, sortNumeric, tushareQuery, unique } from "./tushare.js";

export const A_SHARE_PATTERNS = "6*.SH,0*.SZ,3*.SZ,9*.BJ,4*.BJ,8*.BJ";

export function enrichRealtime(rows: Row[]): Row[] {
  return rows.map(r => {
    const pre = n(r.pre_close), close = n(r.close), high = n(r.high), low = n(r.low);
    const pct = pre && close !== null ? (close / pre - 1) * 100 : n(r.pct_change);
    return {
      ...r,
      pct_change: pct,
      amplitude_pct: pre && high !== null && low !== null ? (high - low) / pre * 100 : null,
      rebound_from_low_pct: close !== null && low ? (close / low - 1) * 100 : null,
      distance_from_high_pct: close !== null && high ? (close / high - 1) * 100 : null,
      risk_name: /ST|退/.test(String(r.name || "")),
    };
  });
}

export async function realtimeMarket(): Promise<Row[]> {
  return enrichRealtime(await tushareQuery("rt_k", { ts_code: A_SHARE_PATTERNS }));
}

export function marketTradeTime(rows: Row[]): string | null {
  const xs = rows.map(r => s(r.trade_time)).filter((x): x is string => !!x);
  return xs.length ? xs.sort().at(-1)! : null;
}

export async function latestOpenDate(): Promise<string> {
  const now = new Date();
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replaceAll("-", "");
  const start = new Date(now.getTime() - 14 * 86400000);
  const rows = await tushareQuery("trade_cal", {
    exchange: "SSE", start_date: fmt(start), end_date: fmt(now), is_open: "1",
  }, "exchange,cal_date,is_open");
  const dates = rows.map(r => s(r.cal_date)).filter((x): x is string => !!x).sort();
  return dates.at(-1) || fmt(now);
}

export async function previousOpenDate(current: string): Promise<string | null> {
  const y = Number(current.slice(0,4)), m = Number(current.slice(4,6)), d = Number(current.slice(6,8));
  const end = new Date(Date.UTC(y, m-1, d) - 86400000);
  const start = new Date(end.getTime() - 14 * 86400000);
  const fmt = (x: Date) => `${x.getUTCFullYear()}${String(x.getUTCMonth()+1).padStart(2,"0")}${String(x.getUTCDate()).padStart(2,"0")}`;
  const rows = await tushareQuery("trade_cal", {
    exchange: "SSE", start_date: fmt(start), end_date: fmt(end), is_open: "1",
  }, "exchange,cal_date,is_open");
  const dates = rows.map(r => s(r.cal_date)).filter((x): x is string => !!x).sort();
  return dates.at(-1) || null;
}

export function topRows(rows: Row[], field: string, count: number, desc = true): Row[] {
  return sortNumeric(rows, field, desc).slice(0, count);
}

export function summarizeThemeQuotes(rows: Row[], leaders = 5) {
  const valid = rows.filter(r => n(r.pct_change) !== null);
  const pcts = valid.map(r => n(r.pct_change)!).sort((a,b)=>a-b);
  const mean = pcts.length ? pcts.reduce((a,b)=>a+b,0) / pcts.length : null;
  const median = pcts.length ? (pcts.length % 2 ? pcts[(pcts.length-1)/2] : (pcts[pcts.length/2-1]+pcts[pcts.length/2])/2) : null;
  return {
    members_quoted: valid.length,
    mean_pct_change: mean,
    median_pct_change: median,
    advancers: valid.filter(r => n(r.pct_change)! > 0).length,
    decliners: valid.filter(r => n(r.pct_change)! < 0).length,
    above_5pct: valid.filter(r => n(r.pct_change)! >= 5).length,
    near_limit_up_9_5pct: valid.filter(r => n(r.pct_change)! >= 9.5).length,
    total_amount_yuan: valid.reduce((acc,r)=>acc+(n(r.amount)||0),0),
    leaders: topRows(valid, "pct_change", leaders),
  };
}

export async function realtimeForCodes(codes: string[]): Promise<Row[]> {
  const uniq = unique(codes).filter(Boolean);
  const chunks: string[][] = [];
  for (let i=0;i<uniq.length;i+=350) chunks.push(uniq.slice(i,i+350));
  const results = await Promise.all(chunks.map(c => tushareQuery("rt_k", { ts_code: c.join(",") })));
  return enrichRealtime(results.flat());
}
