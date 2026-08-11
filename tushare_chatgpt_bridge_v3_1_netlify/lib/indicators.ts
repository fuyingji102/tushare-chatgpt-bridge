import type { Row } from "./tushare.js";
import { n } from "./tushare.js";

function sma(values: number[], window: number): number | null {
  if (values.length < window) return null;
  const x = values.slice(-window);
  return x.reduce((a, b) => a + b, 0) / x.length;
}

function emaSeries(values: number[], span: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (span + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  return out;
}

function wilderRsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const deltas = values.slice(1).map((v, i) => v - values[i]);
  let gain = 0, loss = 0;
  for (const d of deltas.slice(0, period)) {
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (const d of deltas.slice(period)) {
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function slowKdj(rows: Row[], period = 9): { k: number | null; d: number | null } {
  if (rows.length < period) return { k: null, d: null };
  let k = 50;
  let d = 50;
  for (let i = period - 1; i < rows.length; i++) {
    const slice = rows.slice(i - period + 1, i + 1);
    const lows = slice.map(r => n(r.low)).filter((x): x is number => x !== null);
    const highs = slice.map(r => n(r.high)).filter((x): x is number => x !== null);
    const close = n(rows[i].close);
    if (close === null || !lows.length || !highs.length) continue;
    const lo = Math.min(...lows), hi = Math.max(...highs);
    const rsv = hi === lo ? 50 : (close - lo) / (hi - lo) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }
  return { k, d };
}

export function indicators(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
  const closes = sorted.map(r => n(r.close)).filter((x): x is number => x !== null);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdSeries = ema12.map((x, i) => x - (ema26[i] ?? x));
  const signalSeries = emaSeries(macdSeries, 9);
  const macd = macdSeries.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  const kdj = slowKdj(sorted);
  return {
    ma5: sma(closes, 5),
    ma10: sma(closes, 10),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    macd,
    macd_signal: signal,
    macd_hist: macd !== null && signal !== null ? macd - signal : null,
    rsi14: wilderRsi(closes, 14),
    skdj_k: kdj.k,
    skdj_d: kdj.d,
  };
}

export function qfqDaily(daily: Row[], factors: Row[]): Row[] {
  if (!daily.length || !factors.length) return [...daily].sort((a,b)=>String(a.trade_date).localeCompare(String(b.trade_date)));
  const fmap = new Map(factors.map(r => [String(r.trade_date), n(r.adj_factor)]));
  const sorted = [...daily].sort((a,b)=>String(a.trade_date).localeCompare(String(b.trade_date)));
  const latestFactor = [...factors]
    .sort((a,b)=>String(a.trade_date).localeCompare(String(b.trade_date)))
    .map(r => n(r.adj_factor)).filter((x): x is number => x !== null).at(-1);
  if (!latestFactor) return sorted;
  return sorted.map(r => {
    const f = fmap.get(String(r.trade_date));
    if (!f) return r;
    const ratio = f / latestFactor;
    const out: Row = { ...r, adj_factor: f };
    for (const col of ["open", "high", "low", "close", "pre_close"]) {
      const v = n(r[col]);
      if (v !== null) out[col] = v * ratio;
    }
    return out;
  });
}

export function chinaTradingProgress(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find(p => p.type === "hour")?.value || 0);
  const mm = Number(parts.find(p => p.type === "minute")?.value || 0);
  const mins = hh * 60 + mm;
  if (mins < 570) return 0;
  if (mins <= 690) return Math.min(0.5, (mins - 570) / 240);
  if (mins < 780) return 0.5;
  if (mins <= 900) return Math.min(1, (120 + mins - 780) / 240);
  return 1;
}
