import type { Row } from "./tushare.js";
import { n, s } from "./tushare.js";
import { indicators } from "./indicators.js";

export type RegimeLabel = "ignition" | "expansion" | "climax" | "divergence" | "retreat" | "repair" | "neutral";
export type BreakoutStage = "B0" | "B1" | "B2" | "B3" | "FAILED" | "WAIT";

export function clamp(x:number, lo=0, hi=100){ return Math.max(lo, Math.min(hi, x)); }
export function mean(xs:number[]){ return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; }
export function median(xs:number[]){
  if(!xs.length) return null;
  const a=[...xs].sort((x,y)=>x-y), m=Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}
export function pctRank(value:number|null, values:number[], higherIsBetter=true){
  if(value===null || !Number.isFinite(value) || !values.length) return 0.5;
  const valid=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!valid.length) return 0.5;
  let le=0; for(const x of valid) if(x<=value) le++;
  const p=le/valid.length;
  return higherIsBetter?p:1-p;
}

function sortedRows(rows:Row[]){ return [...rows].sort((a,b)=>String(a.trade_date||a.source_time||"").localeCompare(String(b.trade_date||b.source_time||""))); }
function closes(rows:Row[]){ return rows.map(r=>n(r.close)).filter((x):x is number=>x!==null); }
function highs(rows:Row[]){ return rows.map(r=>n(r.high)).filter((x):x is number=>x!==null); }
function lows(rows:Row[]){ return rows.map(r=>n(r.low)).filter((x):x is number=>x!==null); }
function vols(rows:Row[]){ return rows.map(r=>n(r.vol_hands) ?? n(r.vol)).filter((x):x is number=>x!==null); }
function avgLast(xs:number[], k:number){ const a=xs.slice(-k); return mean(a); }
function rollingHigh(rows:Row[], k:number){ const xs=highs(rows.slice(-k)); return xs.length?Math.max(...xs):null; }

function trueRangeRows(rows:Row[]){
  const out:number[]=[];
  for(let i=0;i<rows.length;i++){
    const hi=n(rows[i].high), lo=n(rows[i].low), pc=i? n(rows[i-1].close):null;
    if(hi===null||lo===null) continue;
    out.push(pc===null ? hi-lo : Math.max(hi-lo, Math.abs(hi-pc), Math.abs(lo-pc)));
  }
  return out;
}

export function baseMetrics(history:Row[]){
  const rows=sortedRows(history); const tech=indicators(rows);
  const c=closes(rows), tr=trueRangeRows(rows), v=vols(rows);
  const recent5=rows.slice(-5), recent20=rows.slice(-20);
  const amp=(r:Row)=>{const hi=n(r.high),lo=n(r.low),cl=n(r.close);return hi!==null&&lo!==null&&cl? (hi-lo)/cl*100:null;};
  const amp5=mean(recent5.map(amp).filter((x):x is number=>x!==null));
  const amp20=mean(recent20.map(amp).filter((x):x is number=>x!==null));
  const atr5=avgLast(tr,5), atr20=avgLast(tr,20);
  const last=c.at(-1)||null;
  const mas=[tech.ma5,tech.ma10,tech.ma20].filter((x):x is number=>x!==null);
  const maSpread=last&&mas.length>=2 ? (Math.max(...mas)-Math.min(...mas))/last*100 : null;
  const vol5=avgLast(v,5), vol20=avgLast(v,20);
  const atrContract=atr5!==null&&atr20?atr5/atr20:null;
  const ampContract=amp5!==null&&amp20?amp5/amp20:null;
  const volContract=vol5!==null&&vol20?vol5/vol20:null;
  let score=50;
  if(atrContract!==null) score += clamp((1.05-atrContract)*45,-20,20);
  if(ampContract!==null) score += clamp((1.05-ampContract)*35,-15,15);
  if(maSpread!==null) score += clamp((2.8-maSpread)*7,-15,15);
  if(volContract!==null) score += clamp((1.0-volContract)*18,-8,8);
  return {score:clamp(score),atr5,atr20,atr5_atr20:atrContract,amplitude5_pct:amp5,amplitude20_pct:amp20,amplitude_ratio:ampContract,ma_spread_pct:maSpread,volume5:vol5,volume20:vol20,volume5_20_ratio:volContract};
}

function compoundDaily(rows:Row[], days:number){
  const xs=sortedRows(rows).slice(-days).map(r=>n(r.pct_chg) ?? n(r.pct_change)).filter((x):x is number=>x!==null);
  if(!xs.length) return null;
  return (xs.reduce((acc,x)=>acc*(1+x/100),1)-1)*100;
}

function recentBreakout(history:Row[], lookback=5){
  const rows=sortedRows(history);
  for(let i=Math.max(60,rows.length-lookback);i<rows.length;i++){
    const prior=rows.slice(Math.max(0,i-60),i); if(prior.length<20) continue;
    const level=rollingHigh(prior,60); const close=n(rows[i].close), high=n(rows[i].high);
    if(level!==null&&close!==null&&high!==null&&high>=level&&close>=level*0.995){
      return {index:i,row:rows[i],level,days_ago:rows.length-1-i};
    }
  }
  return null;
}

export function analyzeBreakout(opts:{
  history:Row[];
  live:Row;
  marketScore:number;
  marketRegime:RegimeLabel;
  sectorScore:number;
  sectorReturnPct:number|null;
  sectorStatus:string;
  minAmountYuan:number;
}){
  const history=sortedRows(opts.history);
  const live=opts.live;
  const current=n(live.close), high=n(live.high), low=n(live.low), pre=n(live.pre_close), amount=n(live.amount) ?? n(live.amount_yuan) ?? 0;
  if(current===null) return null;
  const prior=history.filter(r=>String(r.trade_date||"")!==String(s(live.trade_date)||"")).slice(-120);
  const prior20=prior.slice(-20), prior60=prior.slice(-60);
  const high20=rollingHigh(prior20,20), high60=rollingHigh(prior60,60);
  const reference=high60 ?? high20;
  const distanceToBreakout=reference ? (current/reference-1)*100 : null;
  const tech=indicators([...prior,{...live,trade_date:s(live.trade_date)||s(live.source_time)?.slice(0,10).replaceAll("-","")||"99999999"}]);
  const bm=baseMetrics(prior.slice(-30));
  const hv=vols(prior), avg20Vol=avgLast(hv,20);
  const rawCurrentVol=n(live.vol_hands) ?? n(live.vol);
  let currentVol=rawCurrentVol; let volumeNormalization="none";
  if(currentVol!==null&&avg20Vol){
    const rawRatio=currentVol/avg20Vol;
    if(rawRatio>20&&rawRatio/100>=0.05&&rawRatio/100<=12){currentVol=currentVol/100;volumeNormalization="divided_by_100_against_20d_history";}
    else if(rawRatio<0.05&&rawRatio*100>=0.05&&rawRatio*100<=12){currentVol=currentVol*100;volumeNormalization="multiplied_by_100_against_20d_history";}
  }
  const volumeRatio=currentVol!==null&&avg20Vol ? currentVol/avg20Vol : null;
  const rsMarket=n(live.pct_change) ?? (pre? (current/pre-1)*100:null);
  const rsSector=rsMarket!==null&&opts.sectorReturnPct!==null ? rsMarket-opts.sectorReturnPct : null;
  const ret5=compoundDaily(prior.slice(-5),5), ret20=compoundDaily(prior.slice(-20),20);
  const ma5=tech.ma5, ma20=tech.ma20;
  const extensionMa5=ma5 ? (current/ma5-1)*100 : null;
  const extensionMa20=ma20 ? (current/ma20-1)*100 : null;
  const priorBreak=recentBreakout(prior,5);

  let stage:BreakoutStage="WAIT"; let breakoutLevel=reference;
  if(priorBreak){
    breakoutLevel=priorBreak.level;
    const near=breakoutLevel ? current>=breakoutLevel*0.985 && current<=breakoutLevel*1.035 : false;
    const touched=breakoutLevel&&low!==null ? low<=breakoutLevel*1.02 : false;
    const breakoutVol=n(priorBreak.row.vol_hands) ?? n(priorBreak.row.vol);
    const shrink=currentVol!==null&&breakoutVol ? currentVol<=breakoutVol*0.95 : true;
    if(current < breakoutLevel*0.97) stage="FAILED";
    else if(near&&touched&&shrink&&current>=breakoutLevel*0.995) stage="B2";
  }
  const extended=(extensionMa5!==null&&extensionMa5>=7)||(ret5!==null&&ret5>=18)||(extensionMa20!==null&&extensionMa20>=18);
  if(stage==="WAIT"&&extended) stage="B3";
  if(stage==="WAIT"&&reference!==null){
    const hit=high!==null&&high>=reference*0.998;
    const closesAbove=current>=reference*0.997;
    if(hit&&closesAbove&&(volumeRatio===null||volumeRatio>=1.15)) stage="B1";
    else if(distanceToBreakout!==null&&distanceToBreakout>=-3&&distanceToBreakout<0.8&&bm.score>=55) stage="B0";
  }

  const marketComponent=clamp(opts.marketScore)*0.15;
  const sectorComponent=clamp(opts.sectorScore)*0.20;
  const baseComponent=clamp(bm.score)*0.15;
  const breakoutQuality=stage==="B1"?90:stage==="B2"?92:stage==="B0"?72:stage==="B3"?55:stage==="FAILED"?10:45;
  const breakoutComponent=breakoutQuality*0.20;
  const volumeQuality=volumeRatio===null?50:clamp(50+(volumeRatio-1)*35);
  const volumeComponent=volumeQuality*0.10;
  const rsQuality=rsSector===null?50:clamp(50+rsSector*8);
  const rsComponent=rsQuality*0.10;
  const liquidityQuality=clamp(amount/Math.max(opts.minAmountYuan,1)*55,0,100);
  const liquidityComponent=liquidityQuality*0.10;
  const extensionPenalty=stage==="B3"?20:clamp(Math.max(0,(extensionMa5??0)-4)*2.5,0,18);
  const score=clamp(marketComponent+sectorComponent+baseComponent+breakoutComponent+volumeComponent+rsComponent+liquidityComponent-extensionPenalty);

  const invalidation=breakoutLevel?breakoutLevel*0.97:(ma20??(low??current)*0.97);
  const b1Low=breakoutLevel??current, b1High=breakoutLevel?breakoutLevel*1.015:current*1.01;
  const b2Low=breakoutLevel?breakoutLevel*0.985:(ma5??current)*0.99, b2High=breakoutLevel?breakoutLevel*1.005:(ma5??current)*1.005;
  const chaseAbove=breakoutLevel?breakoutLevel*1.06:(ma5??current)*1.07;
  const signalId=`${s(live.ts_code)||"UNKNOWN"}-${s(live.source_time)?.slice(0,10).replaceAll("-","")||s(live.trade_date)||"NA"}-${stage}`;

  return {
    ts_code:live.ts_code,name:live.name,industry:live.industry,stage,score,
    breakout:{reference_level:breakoutLevel,high20:high20,high60:high60,distance_to_breakout_pct:distanceToBreakout,days_since_prior_breakout:priorBreak?.days_ago??null},
    base:bm,
    volume:{raw_current_volume_hands:rawCurrentVol,current_volume_hands:currentVol,avg20_volume_hands:avg20Vol,volume_ratio_20d:volumeRatio,normalization:volumeNormalization},
    relative_strength:{stock_pct_change:rsMarket,sector_pct_change:opts.sectorReturnPct,stock_minus_sector_pct:rsSector,sector_status:opts.sectorStatus},
    trend:{ma5:tech.ma5,ma10:tech.ma10,ma20:tech.ma20,ma60:tech.ma60,ret5_pct:ret5,ret20_pct:ret20,extension_from_ma5_pct:extensionMa5,extension_from_ma20_pct:extensionMa20,rsi14:tech.rsi14,skdj_k:tech.skdj_k,skdj_d:tech.skdj_d},
    execution:{b1_trigger_zone:[b1Low,b1High],b2_retest_zone:[b2Low,b2High],invalidation_below:invalidation,chase_zone_above:chaseAbove},
    scoring:{market:marketComponent,sector:sectorComponent,base:baseComponent,breakout:breakoutComponent,volume:volumeComponent,relative_strength:rsComponent,liquidity:liquidityComponent,extension_penalty:extensionPenalty},
    signal_record:{signal_id:signalId,signal_stage:stage,signal_price:current,breakout_level:breakoutLevel,market_regime:opts.marketRegime,sector_status:opts.sectorStatus,score,evaluation_horizons_days:[1,3,5,10],metrics_to_fill:["forward_return","MFE","MAE","invalidation_hit"]}
  };
}

export function classifyRegime(input:{advancers:number;decliners:number;medianPct:number|null;above5:number;below5:number;sealedUp?:number;opened?:number;sealedDown?:number}){
  const total=Math.max(1,input.advancers+input.decliners), advRatio=input.advancers/total;
  const med=input.medianPct??0, sealedUp=input.sealedUp??0, opened=input.opened??0, sealedDown=input.sealedDown??0;
  const failRate=(sealedUp+opened)>0?opened/(sealedUp+opened):0;
  const breadthStrength=clamp(advRatio*100);
  const medianStrength=clamp(50+med*22);
  const tails=clamp(50+(input.above5-input.below5)*0.35);
  const boardQuality=clamp(70-failRate*55-sealedDown*0.3+Math.min(20,sealedUp*0.15));
  const score=clamp(breadthStrength*0.4+medianStrength*0.25+tails*0.2+boardQuality*0.15);
  let regime:RegimeLabel="neutral";
  if(advRatio<0.24 || med<-1.1 || (input.below5>input.above5*1.35&&input.below5>60)) regime="retreat";
  else if(advRatio<0.42 || med<-0.35) regime="divergence";
  else if(advRatio>0.78&&med>1.1&&failRate<0.2) regime="climax";
  else if(advRatio>0.63&&med>0.45) regime="expansion";
  else if(advRatio>=0.5&&med>0.15&&input.above5>input.below5*1.2) regime="ignition";
  else if(advRatio>=0.43&&med>=-0.15) regime="repair";
  const recommendedMode=regime==="retreat"?"WAIT_or_only_A_grade_B2":regime==="divergence"?"B2_preferred_B1_selective":regime==="climax"?"avoid_late_B3_B1_selective":regime==="expansion"||regime==="ignition"?"B1_and_B2_allowed":"B2_preferred";
  return {regime,score,breakout_environment:score>=68?"supportive":score>=40?"selective":"hostile",recommended_mode:recommendedMode,advancer_ratio:advRatio,failed_board_rate:failRate,components:{breadth_strength:breadthStrength,median_strength:medianStrength,tail_strength:tails,board_quality:boardQuality}};
}
