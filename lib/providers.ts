import type { Row } from "./tushare.js";
import { n, s } from "./tushare.js";

export type DataQualityStatus = "verified" | "usable" | "degraded" | "stale" | "fallback";
export type Coverage = "full" | "ranked_partial" | "single" | "unknown";

export interface ProviderResult<T> {
  ok: boolean;
  source: string;
  data: T;
  fetched_at_cn: string;
  source_time: string | null;
  latency_ms: number;
  error: string | null;
  coverage?: Coverage;
  total_reported?: number | null;
}

const EM_UT = "bd1d9ddb04089700cf9c27f6f7426281";
const EM_HIS_UT = "7eea3edcaed734bea9cbfc24409ed989";
const A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const EM_FIELDS = "f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f14,f15,f16,f17,f18,f20,f21,f22,f23,f124";
const CACHE = new Map<string, { expires: number; value: unknown }>();

function cnNow(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace(" ", "T") + "+08:00";
}

function cacheGet<T>(key: string): T | null {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) { CACHE.delete(key); return null; }
  return hit.value as T;
}
function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  CACHE.set(key, { expires: Date.now() + ttlMs, value });
  return value;
}

async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = 5500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "accept": "application/json,text/plain,*/*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        ...(init.headers || {}),
      },
    });
  } finally { clearTimeout(timer); }
}

function normalizeDiff(x: unknown): Row[] {
  if (Array.isArray(x)) return x.filter(v => v && typeof v === "object") as Row[];
  if (x && typeof x === "object") return Object.values(x as Record<string, unknown>).filter(v => v && typeof v === "object") as Row[];
  return [];
}

async function eastmoneyJson(path: string, params: Record<string, string | number>, timeoutMs = 5500): Promise<any> {
  const hosts = ["https://push2.eastmoney.com", "https://82.push2.eastmoney.com", "https://79.push2.eastmoney.com"];
  let last: unknown = null;
  for (const host of hosts) {
    try {
      const u = new URL(path, host);
      for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
      const r = await timedFetch(u.toString(), { headers: { referer: "https://quote.eastmoney.com/" } }, timeoutMs);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      if (!body || body.data === null || body.data === undefined) throw new Error("empty data");
      return body;
    } catch (e) { last = e; }
  }
  throw new Error(`Eastmoney unavailable: ${last instanceof Error ? last.message : String(last)}`);
}

function numericCodeToTs(code: string): string {
  if (/^6/.test(code)) return `${code}.SH`;
  if (/^[0123]/.test(code)) return `${code}.SZ`;
  if (/^[489]/.test(code)) return `${code}.BJ`;
  return code;
}

export function eastmoneySecid(tsCode: string): string {
  const [code, ex] = tsCode.toUpperCase().split(".");
  return `${ex === "SH" ? "1" : "0"}.${code}`;
}

function epochToCnIso(value: unknown): string | null {
  const x = n(value);
  if (x === null || x < 1_000_000_000) return null;
  const ms = x > 10_000_000_000 ? x : x * 1000;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(ms)).replace(" ", "T") + "+08:00";
}

function mapEastmoneyRow(r: Row): Row {
  const code = String(r.f12 || "");
  const pre = n(r.f18), close = n(r.f2), high = n(r.f15), low = n(r.f16);
  return {
    ts_code: numericCodeToTs(code), symbol: code, name: r.f14,
    close, pre_close: pre, open: n(r.f17), high, low,
    change: n(r.f4), pct_change: n(r.f3), pct_chg: n(r.f3),
    vol: n(r.f5), vol_hands: n(r.f5), amount: n(r.f6), amount_yuan: n(r.f6),
    amplitude_pct: n(r.f7), turnover_rate: n(r.f8), pe_dynamic: n(r.f9),
    volume_ratio: n(r.f10), five_min_pct: n(r.f11), speed_pct: n(r.f22), pb: n(r.f23),
    total_mv: n(r.f20), circ_mv: n(r.f21),
    trade_time: epochToCnIso(r.f124), source_time: epochToCnIso(r.f124),
    distance_from_high_pct: close !== null && high ? (close / high - 1) * 100 : null,
    rebound_from_low_pct: close !== null && low ? (close / low - 1) * 100 : null,
    risk_name: /ST|退/.test(String(r.f14 || "")),
    provider: "eastmoney",
  };
}

export async function eastmoneyQuotes(tsCodes: string[]): Promise<ProviderResult<Row[]>> {
  const codes = [...new Set(tsCodes.map(x=>x.toUpperCase()))].filter(Boolean);
  const key = `em:q:${codes.sort().join(",")}`;
  const cached = cacheGet<ProviderResult<Row[]>>(key); if (cached) return cached;
  const started = Date.now(), fetched = cnNow();
  try {
    const secids = codes.map(eastmoneySecid).join(",");
    const body = await eastmoneyJson("/api/qt/ulist.np/get", { secids, fields: EM_FIELDS, fltt: 2, invt: 2, ut: EM_UT });
    const rows = normalizeDiff(body.data?.diff).map(mapEastmoneyRow);
    const result: ProviderResult<Row[]> = {
      ok: rows.length > 0, source: "eastmoney", data: rows, fetched_at_cn: fetched,
      source_time: rows.map(r=>s(r.source_time)).filter((x):x is string=>!!x).sort().at(-1) || null,
      latency_ms: Date.now()-started, error: rows.length ? null : "No quote rows", coverage: "single",
    };
    return cacheSet(key, result, 7000);
  } catch (e) {
    return { ok:false, source:"eastmoney", data:[], fetched_at_cn:fetched, source_time:null, latency_ms:Date.now()-started, error:e instanceof Error?e.message:String(e), coverage:"single" };
  }
}

export async function eastmoneyQuote(tsCode: string): Promise<ProviderResult<Row | null>> {
  const r = await eastmoneyQuotes([tsCode]);
  return { ...r, data: r.data.at(0) || null };
}



function tencentSymbol(tsCode: string): string {
  const [code, ex] = tsCode.toUpperCase().split(".");
  const prefix = ex === "SH" ? "sh" : ex === "SZ" ? "sz" : "bj";
  return `${prefix}${code}`;
}

function tencentTimeToIso(value: unknown): string | null {
  const x = String(value || "").trim();
  if (!/^\d{14}$/.test(x)) return null;
  return `${x.slice(0,4)}-${x.slice(4,6)}-${x.slice(6,8)}T${x.slice(8,10)}:${x.slice(10,12)}:${x.slice(12,14)}+08:00`;
}

async function fetchGbkText(url: string, timeoutMs = 5000): Promise<string> {
  const r = await timedFetch(url, { headers: { accept: "text/plain,*/*" } }, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  try { return new TextDecoder("gb18030").decode(buf); }
  catch { return new TextDecoder().decode(buf); }
}

function parseTencentQuotePayload(text: string, requested: Map<string,string>): Row[] {
  const rows: Row[] = [];
  const re = /v_([^=]+)="([^"]*)";?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1].replace(/^s_/, "");
    const a = m[2].split("~");
    if (a.length < 35) continue;
    const tsCode = requested.get(symbol) || numericCodeToTs(String(a[2] || ""));
    const close=n(a[3]), pre=n(a[4]), high=n(a[33]), low=n(a[34]);
    const amountWan=n(a[37]);
    const sourceTime=tencentTimeToIso(a[30]);
    rows.push({
      ts_code:tsCode, symbol:String(a[2]||""), name:a[1]||null,
      close, pre_close:pre, open:n(a[5]), high, low,
      change:n(a[31]) ?? (close!==null&&pre!==null?close-pre:null),
      pct_change:n(a[32]) ?? (close!==null&&pre?(close/pre-1)*100:null),
      pct_chg:n(a[32]) ?? (close!==null&&pre?(close/pre-1)*100:null),
      // Tencent A-share quote field 6 is conventionally reported in hands.
      vol:n(a[6]), vol_hands:n(a[6]),
      // Field 37 is conventionally turnover amount in 10k CNY; normalize to yuan.
      amount:amountWan!==null?amountWan*10000:null, amount_yuan:amountWan!==null?amountWan*10000:null,
      turnover_rate:n(a[38]), pe_dynamic:n(a[39]), amplitude_pct:n(a[43]), pb:n(a[46]),
      source_time:sourceTime, trade_time:sourceTime,
      distance_from_high_pct:close!==null&&high?(close/high-1)*100:null,
      rebound_from_low_pct:close!==null&&low?(close/low-1)*100:null,
      risk_name:/ST|退/.test(String(a[1]||"")), provider:"tencent",
    });
  }
  return rows;
}

export async function tencentQuotes(tsCodes: string[]): Promise<ProviderResult<Row[]>> {
  const codes=[...new Set(tsCodes.map(x=>x.toUpperCase()))].filter(Boolean);
  const key=`tx:q:${codes.slice().sort().join(",")}`;
  const cached=cacheGet<ProviderResult<Row[]>>(key); if(cached) return cached;
  const started=Date.now(), fetched=cnNow();
  if(!codes.length) return {ok:true,source:"tencent",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:0,error:null,coverage:"single"};
  try{
    const symbols=codes.map(tencentSymbol);
    const requested=new Map(symbols.map((sym,i)=>[sym,codes[i]]));
    const text=await fetchGbkText(`https://qt.gtimg.cn/q=${symbols.join(",")}`,5000);
    const rows=parseTencentQuotePayload(text,requested);
    const sourceTime=rows.map(r=>s(r.source_time)).filter((x):x is string=>!!x).sort().at(-1)||null;
    const out:ProviderResult<Row[]>={ok:rows.length>0,source:"tencent",data:rows,fetched_at_cn:fetched,source_time:sourceTime,latency_ms:Date.now()-started,error:rows.length?null:"No Tencent quote rows",coverage:"single",total_reported:rows.length};
    return cacheSet(key,out,7000);
  }catch(e){return {ok:false,source:"tencent",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"single",total_reported:0};}
}

export async function tencentQuote(tsCode:string):Promise<ProviderResult<Row|null>>{
  const r=await tencentQuotes([tsCode]); return {...r,data:r.data.at(0)||null};
}

export async function tencentQuotesBatched(tsCodes:string[], chunkSize=90, concurrency=8):Promise<ProviderResult<Row[]>>{
  const codes=[...new Set(tsCodes.map(x=>x.toUpperCase()))].filter(Boolean);
  const started=Date.now(),fetched=cnNow();
  if(!codes.length)return {ok:true,source:"tencent",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:0,error:null,coverage:"full",total_reported:0};
  const chunks:string[][]=[];for(let i=0;i<codes.length;i+=chunkSize)chunks.push(codes.slice(i,i+chunkSize));
  const results:ProviderResult<Row[]>[]=[];
  for(let i=0;i<chunks.length;i+=concurrency){results.push(...await Promise.all(chunks.slice(i,i+concurrency).map(c=>tencentQuotes(c))));}
  const byCode=new Map<string,Row>();for(const r of results)for(const row of r.data)byCode.set(String(row.ts_code),row);
  const rows=[...byCode.values()]; const ratio=codes.length?rows.length/codes.length:1;
  const sourceTime=results.map(x=>x.source_time).filter((x):x is string=>!!x).sort().at(-1)||null;
  const errors=results.map(x=>x.error).filter((x):x is string=>!!x);
  return {ok:rows.length>0,source:"tencent",data:rows,fetched_at_cn:fetched,source_time:sourceTime,latency_ms:Date.now()-started,error:errors.length?`${errors.length}/${results.length} Tencent batches failed; coverage ${(ratio*100).toFixed(1)}%`:null,coverage:ratio>=0.97?"full":"ranked_partial",total_reported:codes.length};
}

export const CORE_INDEX_CODES = ["000001.SH","000016.SH","000300.SH","000905.SH","000852.SH","399001.SZ","399006.SZ","000688.SH"] as const;

export async function tencentIndices():Promise<ProviderResult<Row[]>>{
  return tencentQuotes([...CORE_INDEX_CODES]);
}
export async function sinaQuote(tsCode: string): Promise<ProviderResult<Row | null>> {
  const key = `sina:q:${tsCode}`;
  const cached = cacheGet<ProviderResult<Row|null>>(key); if (cached) return cached;
  const started=Date.now(), fetched=cnNow();
  try {
    const [digits, ex] = tsCode.toUpperCase().split(".");
    const prefix = ex === "SH" ? "sh" : ex === "SZ" ? "sz" : "bj";
    const r = await timedFetch(`https://hq.sinajs.cn/list=${prefix}${digits}`, { headers:{ referer:"https://finance.sina.com.cn/" } }, 4500);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const m = text.match(/="([^"]*)"/);
    if (!m || !m[1]) throw new Error("Empty Sina quote");
    const a = m[1].split(",");
    if (a.length < 32) throw new Error(`Unexpected Sina quote fields: ${a.length}`);
    const sourceTime = /^\d{4}-\d{2}-\d{2}$/.test(a[30]||"") && /^\d{2}:\d{2}:\d{2}$/.test(a[31]||"") ? `${a[30]}T${a[31]}+08:00` : null;
    const pre=n(a[2]), close=n(a[3]), high=n(a[4]), low=n(a[5]);
    const row: Row = {
      ts_code:tsCode, close, pre_close:pre, open:n(a[1]), high, low,
      change: close!==null&&pre!==null?close-pre:null,
      pct_change: close!==null&&pre? (close/pre-1)*100:null,
      pct_chg: close!==null&&pre? (close/pre-1)*100:null,
      vol: n(a[8])!==null ? n(a[8])!/100 : null, vol_hands: n(a[8])!==null ? n(a[8])!/100 : null,
      amount:n(a[9]), amount_yuan:n(a[9]), source_time:sourceTime, trade_time:sourceTime,
      distance_from_high_pct:close!==null&&high?(close/high-1)*100:null,
      rebound_from_low_pct:close!==null&&low?(close/low-1)*100:null,
      provider:"sina",
    };
    const result: ProviderResult<Row|null>={ok:close!==null,source:"sina",data:row,fetched_at_cn:fetched,source_time:sourceTime,latency_ms:Date.now()-started,error:close!==null?null:"Missing current price",coverage:"single"};
    return cacheSet(key,result,7000);
  } catch(e) {
    return {ok:false,source:"sina",data:null,fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"single"};
  }
}

function quoteAgeSeconds(sourceTime: string | null): number | null {
  if (!sourceTime) return null;
  const t=Date.parse(sourceTime); if (!Number.isFinite(t)) return null;
  return Math.max(0,(Date.now()-t)/1000);
}

function cnClockParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value||"";
  return {
    date:`${get("year")}-${get("month")}-${get("day")}`,
    minute:Number(get("hour"))*60+Number(get("minute")),
    second:Number(get("second")),
    weekday:get("weekday"),
  };
}

function marketAwareFreshness(sourceTime:string|null) {
  const age=quoteAgeSeconds(sourceTime);
  if(!sourceTime || age===null) return {age, stale:false, soft_stale:false, note:null as string|null};
  const t=Date.parse(sourceTime);
  const src=cnClockParts(new Date(t)), now=cnClockParts();
  const weekdayOpen=!['Sat','Sun'].includes(now.weekday);
  if(src.date!==now.date){
    const active=weekdayOpen && now.minute>=570 && now.minute<=900;
    return {age, stale:active, soft_stale:!active, note:`Quote source date ${src.date} differs from current China date ${now.date}.`};
  }
  // During lunch and after the close the market is not expected to print new trades.
  let allowance=180;
  if(now.minute>690 && now.minute<780) allowance=(now.minute-690)*60+now.second+180;
  else if(now.minute>900) allowance=(now.minute-900)*60+now.second+180;
  else if(now.minute<570) allowance=Math.max(180, (570-now.minute)*60);
  return {age, stale:age>allowance+420, soft_stale:age>allowance, note:null as string|null};
}

export function quoteConsensus(primary: Row | null, checks: Array<{source:string; row:Row|null; source_time?:string|null}>) {
  const p=n(primary?.close);
  const valid=checks.filter(x=>n(x.row?.close)!==null);
  const comparisons=valid.map(x=>{
    const q=n(x.row?.close)!;
    const abs=p!==null?Math.abs(q-p):null;
    const pct=p?abs!/p*100:null;
    return {source:x.source,price:q,abs_diff:abs,pct_diff:pct,source_time:x.source_time||s(x.row?.source_time)};
  });
  const maxDiff=comparisons.map(x=>x.pct_diff).filter((x):x is number=>x!==null).reduce((a,b)=>Math.max(a,b),0);
  const agreeing = p!==null ? comparisons.filter(x=>x.pct_diff!==null && (x.abs_diff! <= 0.02 || x.pct_diff! <= 0.08)).length : 0;
  const primaryTime=s(primary?.source_time)||s(primary?.trade_time)||null;
  const freshness=marketAwareFreshness(primaryTime);
  const age=freshness.age;
  let status:DataQualityStatus="usable";
  const warnings:string[]=[];
  if (p===null) {status="fallback";warnings.push("No realtime price available.");}
  else if (comparisons.length && agreeing===comparisons.length) status="verified";
  else if (comparisons.length && maxDiff>0.2) {status="degraded";warnings.push(`Realtime sources disagree by up to ${maxDiff.toFixed(3)}%.`);}
  if (freshness.stale) {status="stale";warnings.push(freshness.note||`Primary provider timestamp is ${Math.round(age||0)} seconds older than expected for the current market phase.`);}
  else if (freshness.soft_stale && status==="verified") {status="usable";warnings.push(freshness.note||`Primary provider timestamp is older than expected for the current market phase.`);}
  if (!comparisons.length && p!==null) warnings.push("Only one realtime provider returned a quote; price is not independently verified.");
  if (p!==null && age===null) warnings.push("Provider did not expose a parseable quote timestamp; freshness is based on request time only.");
  return {status,primary_price:p,primary_source_time:primaryTime,primary_age_seconds:age,cross_checks:comparisons,max_price_difference_pct:comparisons.length?maxDiff:null,independent_sources:1+comparisons.length,warnings};
}

export async function eastmoneyMinutes(tsCode:string,freq:string):Promise<ProviderResult<Row[]>> {
  const f=freq.toUpperCase().replace("MIN","");
  if(!["1","5","15","30","60"].includes(f)) return {ok:false,source:"eastmoney",data:[],fetched_at_cn:cnNow(),source_time:null,latency_ms:0,error:"Unsupported frequency",coverage:"single"};
  const key=`em:min:${tsCode}:${f}`; const cached=cacheGet<ProviderResult<Row[]>>(key); if(cached)return cached;
  const started=Date.now(), fetched=cnNow();
  try{
    const u=new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
    const params:Record<string,string>={fields1:"f1,f2,f3,f4,f5,f6",fields2:"f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",ut:EM_HIS_UT,klt:f,fqt:"0",secid:eastmoneySecid(tsCode),beg:"0",end:"20500101",lmt:"1024"};
    Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));
    const resp=await timedFetch(u.toString(),{headers:{referer:"https://quote.eastmoney.com/"}},6000); if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
    const body=await resp.json() as any; const lines=(body?.data?.klines||[]) as string[]; if(!lines.length)throw new Error("No Eastmoney minute rows");
    const parsed=lines.map(line=>{const a=String(line).split(",");return {ts_code:tsCode,time:a[0],open:n(a[1]),close:n(a[2]),high:n(a[3]),low:n(a[4]),vol:n(a[5]),vol_hands:n(a[5]),amount:n(a[6]),amount_yuan:n(a[6]),amplitude_pct:f==="1"?null:n(a[7]),pct_change:f==="1"?null:n(a[8]),change:f==="1"?null:n(a[9]),turnover_rate:f==="1"?null:n(a[10]),avg_price:f==="1"?n(a[7]):null,provider:"eastmoney"} as Row;});
    const latestDay=String(parsed.at(-1)?.time||"").slice(0,10); const rows=parsed.filter(x=>String(x.time||"").startsWith(latestDay));
    const sourceTime=String(rows.at(-1)?.time||"") ? `${String(rows.at(-1)?.time).replace(" ","T")}+08:00` : null;
    const out:ProviderResult<Row[]>={ok:rows.length>0,source:"eastmoney",data:rows,fetched_at_cn:fetched,source_time:sourceTime,latency_ms:Date.now()-started,error:null,coverage:"single"};
    return cacheSet(key,out,10000);
  }catch(e){return {ok:false,source:"eastmoney",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"single"};}
}

export async function sinaMinutes(tsCode:string,freq:string):Promise<ProviderResult<Row[]>> {
  const f=freq.toUpperCase().replace("MIN",""); if(!["1","5","15","30","60"].includes(f))return {ok:false,source:"sina",data:[],fetched_at_cn:cnNow(),source_time:null,latency_ms:0,error:"Unsupported frequency",coverage:"single"};
  const key=`sina:min:${tsCode}:${f}`;const cached=cacheGet<ProviderResult<Row[]>>(key);if(cached)return cached;
  const started=Date.now(),fetched=cnNow();
  try{
    const [digits,ex]=tsCode.toUpperCase().split("."); const symbol=`${ex==="SH"?"sh":ex==="SZ"?"sz":"bj"}${digits}`;
    const u=new URL("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData");u.searchParams.set("symbol",symbol);u.searchParams.set("scale",f);u.searchParams.set("ma","no");u.searchParams.set("datalen",f==="1"?"360":"240");
    const resp=await timedFetch(u.toString(),{headers:{referer:"https://finance.sina.com.cn/"}},5500);if(!resp.ok)throw new Error(`HTTP ${resp.status}`);const body=await resp.json() as any[];if(!Array.isArray(body)||!body.length)throw new Error("No Sina minute rows");
    const parsed=body.map(x=>{const v=n(x.volume);return {ts_code:tsCode,time:x.day,open:n(x.open),close:n(x.close),high:n(x.high),low:n(x.low),vol:v!==null?v/100:null,vol_hands:v!==null?v/100:null,amount:null,provider:"sina"} as Row;});
    const latestDay=String(parsed.at(-1)?.time||"").slice(0,10);const rows=parsed.filter(x=>String(x.time||"").startsWith(latestDay));const sourceTime=rows.length?`${String(rows.at(-1)!.time).replace(" ","T")}+08:00`:null;
    const out:ProviderResult<Row[]>={ok:rows.length>0,source:"sina",data:rows,fetched_at_cn:fetched,source_time:sourceTime,latency_ms:Date.now()-started,error:null,coverage:"single"};return cacheSet(key,out,12000);
  }catch(e){return {ok:false,source:"sina",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"single"};}
}

function mapClist(body:any):{rows:Row[];total:number|null}{
  const diff=normalizeDiff(body?.data?.diff);return {rows:diff.map(mapEastmoneyRow),total:n(body?.data?.total)};
}

async function eastmoneyClist(params:Record<string,string|number>):Promise<{rows:Row[];total:number|null}>{const b=await eastmoneyJson("/api/qt/clist/get",{pn:1,pz:100,po:1,np:1,ut:EM_UT,fltt:2,invt:2,...params},6500);return mapClist(b);}

export async function eastmoneyMarketFullAttempt():Promise<ProviderResult<Row[]>>{
  const key="em:market:full";const cached=cacheGet<ProviderResult<Row[]>>(key);if(cached)return cached;const started=Date.now(),fetched=cnNow();
  try{const b=await eastmoneyJson("/api/qt/clist/get",{pn:1,pz:6000,po:1,np:1,ut:EM_UT,fltt:2,invt:2,fid:"f3",fs:A_SHARE_FS,fields:EM_FIELDS},7500);const {rows,total}=mapClist(b);const full=rows.length>=1000&&(total===null||rows.length>=Math.min(total,5000)*0.9);const out:ProviderResult<Row[]>={ok:rows.length>0,source:"eastmoney",data:rows,fetched_at_cn:fetched,source_time:rows.map(r=>s(r.source_time)).filter((x):x is string=>!!x).sort().at(-1)||null,latency_ms:Date.now()-started,error:full?null:`Provider returned ${rows.length}/${total??"?"}; not safe for market breadth`,coverage:full?"full":"ranked_partial",total_reported:total};return cacheSet(key,out,12000);}catch(e){return {ok:false,source:"eastmoney",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"unknown",total_reported:null};}
}

export async function eastmoneyMarketRank(field:"pct_change"|"amount",desc=true,count=100):Promise<ProviderResult<Row[]>>{
  const fid=field==="amount"?"f6":"f3";const key=`em:rank:${fid}:${desc}:${count}`;const cached=cacheGet<ProviderResult<Row[]>>(key);if(cached)return cached;const started=Date.now(),fetched=cnNow();
  try{const {rows,total}=await eastmoneyClist({pz:Math.min(100,count),po:desc?1:0,fid,fs:A_SHARE_FS,fields:EM_FIELDS});const out:ProviderResult<Row[]>={ok:rows.length>0,source:"eastmoney",data:rows.slice(0,count),fetched_at_cn:fetched,source_time:rows.map(r=>s(r.source_time)).filter((x):x is string=>!!x).sort().at(-1)||null,latency_ms:Date.now()-started,error:null,coverage:"ranked_partial",total_reported:total};return cacheSet(key,out,10000);}catch(e){return {ok:false,source:"eastmoney",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"ranked_partial"};}
}

export async function eastmoneyBoards(kind:"industry"|"concept",count=300):Promise<ProviderResult<Row[]>>{
  const key=`em:boards:${kind}`;const cached=cacheGet<ProviderResult<Row[]>>(key);if(cached)return cached;const started=Date.now(),fetched=cnNow();
  try{const fs=kind==="industry"?"m:90+t:2+f:!50":"m:90+t:3+f:!50";const {rows,total}=await eastmoneyClist({pz:Math.min(500,count),po:1,fid:"f3",fs,fields:EM_FIELDS});const out:ProviderResult<Row[]>={ok:rows.length>0,source:`eastmoney_${kind}`,data:rows.slice(0,count),fetched_at_cn:fetched,source_time:rows.map(r=>s(r.source_time)).filter((x):x is string=>!!x).sort().at(-1)||null,latency_ms:Date.now()-started,error:null,coverage:rows.length>=Math.min(total||rows.length,count)?"full":"ranked_partial",total_reported:total};return cacheSet(key,out,20000);}catch(e){return {ok:false,source:`eastmoney_${kind}`,data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"unknown"};}
}

export async function eastmoneyBoardMembers(boardCode:string,count=500):Promise<ProviderResult<Row[]>>{
  const key=`em:board:${boardCode}`;const cached=cacheGet<ProviderResult<Row[]>>(key);if(cached)return cached;const started=Date.now(),fetched=cnNow();
  try{const {rows,total}=await eastmoneyClist({pz:Math.min(500,count),po:1,fid:"f3",fs:`b:${boardCode}+f:!50`,fields:EM_FIELDS});const out:ProviderResult<Row[]>={ok:rows.length>0,source:"eastmoney_board_members",data:rows.slice(0,count),fetched_at_cn:fetched,source_time:rows.map(r=>s(r.source_time)).filter((x):x is string=>!!x).sort().at(-1)||null,latency_ms:Date.now()-started,error:null,coverage:rows.length>=Math.min(total||rows.length,count)?"full":"ranked_partial",total_reported:total};return cacheSet(key,out,12000);}catch(e){return {ok:false,source:"eastmoney_board_members",data:[],fetched_at_cn:fetched,source_time:null,latency_ms:Date.now()-started,error:e instanceof Error?e.message:String(e),coverage:"unknown"};}
}

export async function eastmoneyIndices():Promise<ProviderResult<Row[]>>{
  return eastmoneyQuotes([...CORE_INDEX_CODES]);
}
