import { handleTelegramWebhook } from "./telegram.js";
import { fetchTalasanj } from "./providers.js";
import { simulatePaperTrading } from "./paper.js";
const SOURCE = "https://nerkhara.com/api/v1/latest.json";
const MAX_AGE_SECONDS = 660;
const TALASANJ_MAX_AGE_SECONDS = 90;
const SYMBOLS = [
  ["GOLD18","طلای ۱۸ عیار","gold-18k","IRT","تومان"],
  ["GOLD24","طلای ۲۴ عیار","gold-24k","IRT","تومان"],
  ["MESGHAL","مظنه آبشده","gold-mesghal","IRT","تومان"],
  ["COIN_EMAMI","سکه امامی","coin-emami","IRT","تومان"],
  ["COIN_HALF","نیم سکه","coin-half","IRT","تومان"],
  ["COIN_QUARTER","ربع سکه","coin-quarter","IRT","تومان"],
  ["USD_IRT","دلار بازار آزاد","usd","IRT","تومان"],
  ["XAUUSD","اونس جهانی طلا","xau","USD","USD/oz"]
];
let cached = null;
let cachedAt = 0;
const HISTORY_IDS = new Set(SYMBOLS.map(x => x[2]));
const historyCache = new Map();
const HISTORY_TTL_MS = 60 * 60 * 1000;


function ema(values, period) {
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  const out = [values.slice(0, period).reduce((a,b)=>a+b,0) / period];
  for (const value of values.slice(period)) out.push(alpha*value + (1-alpha)*out[out.length-1]);
  return out;
}
function runBacktest(payload) {
  const fastPeriod=Number(payload?.fast_period??20);
  const slowPeriod=Number(payload?.slow_period??50);
  if(!Number.isInteger(fastPeriod)||!Number.isInteger(slowPeriod)||fastPeriod<2||slowPeriod<=fastPeriod||slowPeriod>200)
    throw new Error("fast_period and slow_period must be integers with 2 <= fast_period < slow_period <= 200");
  if (!payload || !Array.isArray(payload.candles) || payload.candles.length < Math.max(60,slowPeriod+2) || payload.candles.length > 5000)
    throw new Error("candles must contain at least max(60, slow_period + 2) and at most 5000 OHLC records");
  const candles = payload.candles.map(c => {
    const row = {timestamp:Date.parse(c?.timestamp),open:Number(c?.open),high:Number(c?.high),low:Number(c?.low),close:Number(c?.close)};
    if (!Number.isFinite(row.timestamp) || ![row.open,row.high,row.low,row.close].every(Number.isFinite) ||
        row.open<=0 || row.high<=0 || row.low<=0 || row.close<=0 || Math.max(row.open,row.high,row.low,row.close)>1e15 ||
        row.high < Math.max(row.open,row.close,row.low) || row.low > Math.min(row.open,row.close,row.high))
      throw new Error("Each candle must contain a valid timestamp and consistent positive OHLC prices within the supported numeric range");
    return {...row,iso:new Date(row.timestamp).toISOString()};
  }).sort((a,b)=>a.timestamp-b.timestamp);
  if (candles.some((c,i)=>i>0 && c.timestamp===candles[i-1].timestamp))
    throw new Error("Candle timestamps must be unique");
  const starting = Number(payload.starting_capital ?? 10000);
  const fee = Number(payload.fee_bps ?? 10);
  const slippage = Number(payload.slippage_bps ?? 5);
  if (!Number.isFinite(starting)||starting<=0||!Number.isFinite(fee)||fee<0||fee>500||
      !Number.isFinite(slippage)||slippage<0||slippage>500)
    throw new Error("starting_capital must be positive and within the supported numeric range; fee/slippage must be between 0 and 500 bps");
  const evaluationStart=Number(payload.evaluation_start_index??0);
  if(!Number.isInteger(evaluationStart)||evaluationStart<0||evaluationStart>candles.length-2||
     (evaluationStart>0&&evaluationStart<slowPeriod+1))
    throw new Error("evaluation_start_index must be zero or at least slow_period + 1 and leave at least one evaluation candle");
  const closes=candles.map(c=>c.close), slow=ema(closes,slowPeriod), fastAligned=ema(closes,fastPeriod).slice(slowPeriod-fastPeriod);
  const cost=(fee+slippage)/10000;
  let cash=starting, quantity=0, entryPrice=null, entryTime=null;
  const trades=[], equityCurve=[{timestamp:candles[evaluationStart].iso,equity:round2(starting)}];
  // Indicators use only candles available before each decision. In walk-forward
  // mode, pre-test candles warm the indicators but are excluded from test P&L.
  for(let candleIndex=evaluationStart+1;candleIndex<candles.length;candleIndex++){
    const signalIndex=candleIndex-slowPeriod;
    if(signalIndex>=1 && signalIndex<slow.length){
      const prevUp=fastAligned[signalIndex-1]>slow[signalIndex-1];
      const nowUp=fastAligned[signalIndex]>slow[signalIndex];
      const up=!prevUp&&nowUp, down=prevUp&&!nowUp;
      const fill=candles[candleIndex].open;
      if(down&&quantity>0){
        const exitPrice=fill*(1-cost), proceeds=quantity*exitPrice;
        const pnl=proceeds-quantity*entryPrice;
        if(!Number.isFinite(exitPrice)||exitPrice<=0||!Number.isFinite(proceeds)||!Number.isFinite(pnl))
          throw new Error("Backtest exit value is outside the supported numeric range");
        cash=proceeds;
        trades.push({entry_time:entryTime,exit_time:candles[candleIndex].iso,
          entry_price:round6(entryPrice),exit_price:round6(exitPrice),pnl:round2(pnl),
          return_pct:round4((exitPrice/entryPrice-1)*100)});
        quantity=0;entryPrice=null;entryTime=null;
      } else if(up&&quantity===0){
        entryPrice=fill*(1+cost);quantity=cash/entryPrice;
        if(!Number.isFinite(entryPrice)||entryPrice<=0||!Number.isFinite(quantity)||quantity<=0)
          throw new Error("Backtest position size is outside the supported numeric range");
        cash=0;entryTime=candles[candleIndex].iso;
      }
    }
    const equity=quantity===0?cash:quantity*candles[candleIndex].close;
    if(!Number.isFinite(equity)||equity<=0)
      throw new Error("Backtest equity is outside the supported numeric range");
    equityCurve.push({timestamp:candles[candleIndex].iso,equity:round2(equity)});
  }
  const finalEquity=quantity===0?cash:quantity*candles[candles.length-1].close;
  if(!Number.isFinite(finalEquity)||finalEquity<=0)
    throw new Error("Final backtest equity is outside the supported numeric range");
  let peak=starting,maxDrawdown=0;
  for(const point of equityCurve){peak=Math.max(peak,point.equity);if(peak>0)maxDrawdown=Math.max(maxDrawdown,(peak-point.equity)/peak);}
  const wins=trades.filter(t=>t.pnl>0).length;
  const profit=trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const loss=Math.abs(trades.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0));
  return {strategy:`EMA${fastPeriod}/EMA${slowPeriod} long-only crossover`,fast_period:fastPeriod,slow_period:slowPeriod,
    execution:"Signal confirmed at candle close; orders filled at next candle open",
    evaluation_start_index:evaluationStart,evaluation_start_at:candles[evaluationStart].iso,
    cost_model:{fee_bps_per_side:fee,slippage_bps_per_side:slippage},
    starting_capital:round2(starting),final_equity:round2(finalEquity),
    net_return_pct:round4((finalEquity/starting-1)*100),
    max_drawdown_pct:round4(maxDrawdown*100),closed_trades:trades.length,
    win_rate_pct:trades.length?round2(wins/trades.length*100):0,
    profit_factor:loss>0?round4(profit/loss):profit>0?"infinity":null,
    open_position:quantity>0,
    unrealized_pnl:round2(quantity>0?finalEquity-quantity*entryPrice:0),
    trades,equity_curve:equityCurve,
    warning:"Research only. Requires reliable OHLC candles; excludes taxes, funding, market impact, gaps beyond next-open fills, and broker constraints. Not a trading recommendation."};
}

function runWalkForward(payload) {
  if(!payload||!Array.isArray(payload.candles)||payload.candles.length<180||payload.candles.length>5000)
    throw new Error("Walk-forward evaluation requires 180 to 5000 OHLC candles");
  const candles=[...payload.candles].sort((a,b)=>Date.parse(a?.timestamp)-Date.parse(b?.timestamp));
  const candidates=[[9,21],[12,26],[20,50]];
  const starting=Number(payload.starting_capital??10000);
  const fee=Number(payload.fee_bps??10),slippage=Number(payload.slippage_bps??5);
  if(!Number.isFinite(starting)||starting<=0||!Number.isFinite(fee)||fee<0||fee>500||
     !Number.isFinite(slippage)||slippage<0||slippage>500)
    throw new Error("Invalid starting capital or transaction costs");
  const n=candles.length;
  const boundaries=[Math.floor(n*0.55),Math.floor(n*0.70),Math.floor(n*0.85)];
  let compounded=1,totalTrades=0,weightedWins=0,maxDrawdown=0;
  const folds=[];
  for(let i=0;i<boundaries.length;i++){
    const trainEnd=boundaries[i],testEnd=i+1<boundaries.length?boundaries[i+1]:n;
    let best=null;
    for(const [fast,slow] of candidates){
      const train=runBacktest({candles:candles.slice(0,trainEnd),fast_period:fast,slow_period:slow,
        starting_capital:starting,fee_bps:fee,slippage_bps:slippage});
      const score=train.net_return_pct-0.5*train.max_drawdown_pct;
      if(!best||score>best.selection_score)
        best={fast_period:fast,slow_period:slow,selection_score:round4(score),
          training_return_pct:train.net_return_pct,training_drawdown_pct:train.max_drawdown_pct};
    }
    const test=runBacktest({candles:candles.slice(0,testEnd),fast_period:best.fast_period,
      slow_period:best.slow_period,starting_capital:starting,fee_bps:fee,slippage_bps:slippage,
      evaluation_start_index:trainEnd});
    compounded*=test.final_equity/starting;
    totalTrades+=test.closed_trades;
    weightedWins+=test.closed_trades*test.win_rate_pct/100;
    maxDrawdown=Math.max(maxDrawdown,test.max_drawdown_pct);
    folds.push({fold:i+1,training_start:candles[0].timestamp,training_end:candles[trainEnd-1].timestamp,
      test_start:candles[trainEnd].timestamp,test_end:candles[testEnd-1].timestamp,
      selected_strategy:`EMA${best.fast_period}/EMA${best.slow_period}`,
      selected_parameters:{fast_period:best.fast_period,slow_period:best.slow_period},
      training_selection_score:best.selection_score,training_return_pct:best.training_return_pct,
      training_drawdown_pct:best.training_drawdown_pct,
      out_of_sample_return_pct:test.net_return_pct,out_of_sample_drawdown_pct:test.max_drawdown_pct,
      out_of_sample_trades:test.closed_trades,out_of_sample_win_rate_pct:test.win_rate_pct,
      out_of_sample_profit_factor:test.profit_factor});
  }
  return {method:"expanding-window walk-forward; each fold selects among EMA 9/21, 12/26, 20/50 using past data only",
    folds,fold_count:folds.length,starting_capital:round2(starting),
    compounded_out_of_sample_return_pct:round4((compounded-1)*100),
    worst_fold_drawdown_pct:round4(maxDrawdown),total_out_of_sample_trades:totalTrades,
    aggregate_out_of_sample_win_rate_pct:totalTrades?round2(weightedWins/totalTrades*100):0,
    cost_model:{fee_bps_per_side:fee,slippage_bps_per_side:slippage},
    execution_enabled:false,
    warning:"Research only. Parameters are selected on each training window and evaluated only on the following unseen window. Small samples, provider quality, spread changes, market impact and broker execution can materially change results; this is not a prediction or trading recommendation."};
}

function evaluateSignal(payload) {
  if(!payload || !Array.isArray(payload.candles) || payload.candles.length<60 || payload.candles.length>5000)
    throw new Error("candles must contain between 60 and 5000 real OHLC records");
  const candles=payload.candles.map(c=>{
    const row={timestamp:Date.parse(c?.timestamp),open:Number(c?.open),high:Number(c?.high),low:Number(c?.low),close:Number(c?.close)};
    if(!Number.isFinite(row.timestamp)||![row.open,row.high,row.low,row.close].every(Number.isFinite)||
      [row.open,row.high,row.low,row.close].some(v=>v<=0||v>1e15)||
      row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high))
      throw new Error("Each candle must contain a valid timestamp and consistent positive OHLC prices");
    return {...row,iso:new Date(row.timestamp).toISOString()};
  }).sort((a,b)=>a.timestamp-b.timestamp);
  if(candles.some((c,i)=>i>0&&c.timestamp<=candles[i-1].timestamp))
    throw new Error("Candle timestamps must be unique");
  const timeframe=Number(payload.timeframe_minutes??60);
  if(!Number.isFinite(timeframe)||timeframe<1||timeframe>10080)
    throw new Error("timeframe_minutes must be between 1 and 10080");
  const last=candles[candles.length-1],ageSeconds=(Date.now()-last.timestamp)/1000;
  const freshnessLimit=Math.max(600,timeframe*120);
  if(ageSeconds < -60 || ageSeconds > freshnessLimit)
    return {signal:"NO_TRADE",confidence:0,reason:"Latest candle is stale or timestamp is in the future.",
      data_status:"STALE",last_candle_at:last.iso,age_seconds:Math.round(ageSeconds),
      execution_enabled:false};
  const closes=candles.map(c=>c.close);
  const fast=ema(closes,20),slow=ema(closes,50);
  const fastNow=fast[fast.length-1],fastPrev=fast[fast.length-2],slowNow=slow[slow.length-1];
  const trend=fastNow>slowNow?"BULLISH":fastNow<slowNow?"BEARISH":"NEUTRAL";
  const changes=closes.slice(1).map((v,i)=>v-closes[i]);
  const gains=changes.map(v=>Math.max(0,v)),losses=changes.map(v=>Math.max(0,-v));
  let avgGain=gains.slice(0,14).reduce((a,b)=>a+b,0)/14;
  let avgLoss=losses.slice(0,14).reduce((a,b)=>a+b,0)/14;
  for(let i=14;i<gains.length;i++){
    avgGain=(avgGain*13+gains[i])/14;
    avgLoss=(avgLoss*13+losses[i])/14;
  }
  const rsi=avgLoss===0?100:avgGain===0?0:100-(100/(1+avgGain/avgLoss));
  const trueRanges=candles.slice(1).map((c,i)=>{
    const prev=candles[i].close;
    return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));
  });
  let atr=trueRanges.slice(0,14).reduce((a,b)=>a+b,0)/14;
  for(let i=14;i<trueRanges.length;i++) atr=(atr*13+trueRanges[i])/14;
  const macdFast=ema(closes,12),macdSlow=ema(closes,26);
  const macdLine=macdFast.slice(14).map((v,i)=>v-macdSlow[i]);
  const macdSignal=ema(macdLine,9);
  const histogram=macdLine[macdLine.length-1]-macdSignal[macdSignal.length-1];
  const slope=fastNow-fastPrev;
  const longChecks=[trend==="BULLISH",last.close>fastNow,slope>0,histogram>0,rsi>=50&&rsi<70];
  const shortChecks=[trend==="BEARISH",last.close<fastNow,slope<0,histogram<0,rsi>30&&rsi<=50];
  const longScore=longChecks.filter(Boolean).length,shortScore=shortChecks.filter(Boolean).length;
  const side=longScore>=4&&longScore>shortScore?"BUY":shortScore>=4&&shortScore>longScore?"SELL":"NO_TRADE";
  const score=side==="BUY"?longScore:side==="SELL"?shortScore:Math.max(longScore,shortScore);
  const confidence=score*20;
  const stopDistance=atr*1.5;
  const entry=last.close;
  if(!Number.isFinite(atr)||atr<=0||!Number.isFinite(stopDistance)||stopDistance<=0||(side==="BUY"&&entry-stopDistance<=0)||(side==="SELL"&&entry-stopDistance*2<=0))
    throw new Error("ATR calculation is outside the supported numeric range");
  const stop=side==="BUY"?entry-stopDistance:side==="SELL"?entry+stopDistance:null;
  const target=side==="BUY"?entry+stopDistance*2:side==="SELL"?entry-stopDistance*2:null;
  const reasons=[];
  if(trend!=="NEUTRAL") reasons.push("EMA20/EMA50 trend: "+trend);
  reasons.push("RSI(14): "+round2(rsi));
  reasons.push("MACD histogram: "+round6(histogram));
  reasons.push("ATR(14): "+round6(atr));
  reasons.push("Confluence checks: "+score+"/5");
  return {signal:side,confidence,confidence_type:"technical_confluence_score_not_probability",
    trend,rsi_14:round2(rsi),macd_histogram:round6(histogram),atr_14:round6(atr),
    entry:side==="NO_TRADE"?null:round6(entry),stop_loss:stop===null?null:round6(stop),
    take_profit:target===null?null:round6(target),risk_reward_ratio:side==="NO_TRADE"?null:2,
    last_candle_at:last.iso,age_seconds:Math.round(ageSeconds),timeframe_minutes:timeframe,
    reasons,execution_enabled:false,
    warning:"Analysis only. Requires genuine, correctly timestamped OHLC candles. Confidence is a confluence score, not a probability. No broker orders are placed."};
}


function classifyMarketRegime(candles) {
  if(!Array.isArray(candles)||candles.length<60) return {status:"INSUFFICIENT_DATA",tradeable:false,reason:"At least 60 completed candles are required."};
  const closes=candles.map(c=>Number(c.close)),fast=ema(closes,20),slow=ema(closes,50);
  const last=candles[candles.length-1],fastNow=fast.at(-1),fastPrev=fast.at(-2),slowNow=slow.at(-1);
  const ranges=candles.slice(-15).map((c,i)=>{const prev=candles[candles.length-16+i].close;return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));});
  const atr=ranges.reduce((s,v)=>s+v,0)/ranges.length,atrPct=atr/last.close*100;
  const spreadPct=Math.abs(fastNow-slowNow)/last.close*100,slopePct=(fastNow-fastPrev)/last.close*100;
  const trend=fastNow>slowNow?"BULLISH":fastNow<slowNow?"BEARISH":"NEUTRAL";
  if(![atrPct,spreadPct,slopePct].every(Number.isFinite)||atrPct<=0) return {status:"UNAVAILABLE",tradeable:false,reason:"Regime indicators could not be calculated."};
  let status,reason;
  if(atrPct>1.5){status="HIGH_VOLATILITY";reason="ATR is above 1.5% of price; volatility filter blocks entries.";}
  else if(spreadPct<0.04&&Math.abs(slopePct)<0.0015){status="RANGE";reason="EMA spread and slope are too small; sideways market filter blocks entries.";}
  else if(spreadPct>=0.04&&((trend==="BULLISH"&&slopePct>0)||(trend==="BEARISH"&&slopePct<0))){status="TRENDING";reason="EMA spread and slope confirm directional movement.";}
  else {status="TRANSITIONAL";reason="Trend structure is not sufficiently consistent; wait for confirmation.";}
  return {status,tradeable:status==="TRENDING",trend,atr_pct:round4(atrPct),ema_spread_pct:round4(spreadPct),ema20_slope_pct:round4(slopePct),reason,
    thresholds:{high_volatility_atr_pct:1.5,range_ema_spread_pct:0.04,range_abs_slope_pct:0.0015}};
}


const CANDLE_SYMBOLS = new Map([["xau", "xau"]]);
const CANDLE_INTERVALS = new Map([["15m", 900], ["30m", 1800], ["60m", 3600], ["1d", 86400]]);

async function fetchGoldCandles(symbol, interval) {
  const providerSymbol = CANDLE_SYMBOLS.get(symbol);
  const intervalSeconds = CANDLE_INTERVALS.get(interval);
  if (!providerSymbol || !intervalSeconds) throw new Error("Unsupported candle symbol or interval");
  const range = interval === "1d" ? "3mo" : "5d";
  const endpoint = "https://xaus.com/api/v1/chart?symbol=" +
    encodeURIComponent(providerSymbol) + "&range=" + range + "&interval=" + interval;
  const response = await fetch(endpoint, {
    headers: {accept:"application/json", "user-agent":"AyyarSmartTrader/1.0"},
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("XAUS OHLC provider HTTP " + response.status);
  const payload = await response.json();
  const state = payload?.data_state?.status;
  if (state && state !== "fresh") throw new Error("XAUS OHLC provider data state is " + state);
  if (!Array.isArray(payload?.points)) throw new Error("XAUS OHLC provider returned an unexpected chart schema");
  const intervalMs = intervalSeconds * 1000;
  const currentBucket = Math.floor(Date.now() / intervalMs) * intervalMs;
  const candles = [];
  let rejectedCompletedPoints=0;
  for (const point of payload.points) {
    const rawTime = Number(point?.t);
    const time = rawTime > 1e12 ? rawTime : rawTime * 1000;
    if (!Number.isFinite(time)) { rejectedCompletedPoints++; continue; }
    if (time >= currentBucket) continue;
    const open=Number(point?.o), high=Number(point?.h);
    const low=Number(point?.l), close=Number(point?.c);
    if (![open,high,low,close].every(v=>Number.isFinite(v)&&v>0&&v<=1e15) ||
        high < Math.max(open,close,low) || low > Math.min(open,close,high)) {
      rejectedCompletedPoints++;
      continue;
    }
    candles.push({timestamp:new Date(time).toISOString(),open,high,low,close});
  }
  if (rejectedCompletedPoints>0)
    throw new Error("XAUS returned "+rejectedCompletedPoints+" malformed completed OHLC points; data quality check failed");
  candles.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  if (candles.some((c,i)=>i>0&&Date.parse(c.timestamp)===Date.parse(candles[i-1].timestamp)))
    throw new Error("XAUS returned duplicate candle timestamps; data quality check failed");
  const last = candles[candles.length-1];
  if (!last) throw new Error("No completed OHLC candles are available from XAUS");
  const ageSeconds=(Date.now()-Date.parse(last.timestamp))/1000;
  const freshnessLimit=Math.max(600,intervalSeconds*2);
  if (ageSeconds < 0 || ageSeconds > freshnessLimit)
    throw new Error("Latest completed XAUS OHLC candle is stale");
  const gaps=[];
  for(let i=1;i<candles.length;i++){
    const delta=(Date.parse(candles[i].timestamp)-Date.parse(candles[i-1].timestamp))/intervalMs;
    if(delta>1.01) gaps.push({from:candles[i-1].timestamp,to:candles[i].timestamp,missing_intervals:Math.max(1,Math.round(delta)-1)});
  }
  const dataQuality={status:gaps.length?"GAPS_DETECTED":"CLEAN",candle_count:candles.length,
    duplicate_count:0,rejected_completed_points:0,gap_count:gaps.length,
    missing_intervals:gaps.reduce((sum,g)=>sum+g.missing_intervals,0),
    largest_gap_intervals:gaps.reduce((max,g)=>Math.max(max,g.missing_intervals),0),
    note:"Gaps are reported for transparency and may reflect market closures or provider omissions; they are not silently filled."};
  return {
    symbol, provider:"XAUS", provider_symbol:providerSymbol, source_url:"https://xaus.com/api/v1/chart",
    interval, interval_seconds:intervalSeconds, status:"LIVE",data_quality:dataQuality,
    retrieved_at:new Date().toISOString(), last_candle_at:last.timestamp,
    age_seconds:Math.round(ageSeconds), candles,
    note:"Completed OHLC candles for global XAU/USD from XAUS chart API. Data is indicative, may be delayed, and is not a broker execution feed. Iranian gold and coin instruments are not represented by this feed."
  };
}
function round2(v){return Math.round(v*100)/100;}
function round4(v){return Math.round(v*10000)/10000;}
function round6(v){return Math.round(v*1000000)/1000000;}

async function archiveSignal(env,symbol,result) {
  if(!env?.SIGNAL_HISTORY || !result?.last_candle_at || result.market_data_status!=="LIVE")
    return {saved:false,alert_status:"NOT_CONFIGURED"};
  const candleTime=Date.parse(result.last_candle_at);
  if(!Number.isFinite(candleTime)) return {saved:false,alert_status:"INVALID_CANDLE"};
  const reverseTime=String(9999999999999-candleTime).padStart(13,"0");
  const key=symbol+":latest:"+reverseTime;
  const existing=await env.SIGNAL_HISTORY.get(key,"json");
  if(existing) return {saved:true,alert_status:existing.alert_status||"ALREADY_ARCHIVED"};
  const previousKeys=await env.SIGNAL_HISTORY.list({prefix:symbol+":latest:",limit:1});
  const previous=previousKeys.keys?.[0]
    ? await env.SIGNAL_HISTORY.get(previousKeys.keys[0].name,"json") : null;
  let alertStatus="NOT_CONFIGURED";
  if(env.BOT_TOKEN && env.SIGNAL_ALERT_CHAT_ID && ["BUY","SELL"].includes(result.signal) &&
      (!previous || previous.signal!==result.signal)) {
    try {
      const sent=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({chat_id:env.SIGNAL_ALERT_CHAT_ID,
          text:"عیار هوشمند | سیگنال پژوهشی جدید\nنماد: XAU/USD\nجهت: "+result.signal+
            "\nامتیاز همگرایی: "+result.confidence+"/100"+
            "\nورود: "+result.entry+"\nحد ضرر: "+result.stop_loss+
            "\nهدف: "+result.take_profit+"\nکندل ۶۰ دقیقه: "+result.last_candle_at+
            "\nداده شاخصی XAUS است؛ احتمال موفقیت نیست و سفارش خودکار انجام نمی‌شود.",
          disable_web_page_preview:true})
      });
      alertStatus=sent.ok?"SENT":"FAILED";
    } catch { alertStatus="FAILED"; }
  }
  const record={...result,symbol,recorded_at:new Date().toISOString(),
    archive_key:key,archive_source:"XAUS completed OHLC multi-timeframe evaluation",
    alert_status:alertStatus,execution_enabled:false};
  await env.SIGNAL_HISTORY.put(key,JSON.stringify(record),{expirationTtl:90*24*60*60});
  return {saved:true,alert_status:alertStatus};
}

function calculateSignalPerformance(records,candles) {
  const horizons=[1,4,24];
  const times=new Map(candles.map((c,i)=>[Date.parse(c.timestamp),i]));
  const stats=Object.fromEntries(horizons.map(h=>[h,{horizon_candles:h,scored:0,wins:0,losses:0,flats:0,
    win_rate_pct:null,average_return_pct:null,average_favorable_pct:null,average_adverse_pct:null}]));
  const outcomes=[];
  let pending=0,unavailable=0;
  const ordered=[...records].filter(r=>r&&["BUY","SELL"].includes(r.signal)&&r.last_candle_at)
    .sort((a,b)=>Date.parse(b.last_candle_at)-Date.parse(a.last_candle_at));
  for(const record of ordered) {
    const signalTime=Date.parse(record.last_candle_at);
    const index=times.get(signalTime);
    if(!Number.isFinite(signalTime)||index===undefined) { unavailable++; continue; }
    const row={signal:record.signal,last_candle_at:record.last_candle_at,outcomes:{}};
    for(const horizon of horizons) {
      const end=index+horizon;
      if(end>=candles.length) { pending++; row.outcomes[horizon]={status:"PENDING",required_future_candles:horizon}; continue; }
      let contiguous=true;
      for(let step=1;step<=horizon;step++) {
        if(times.get(signalTime+step*3600000)!==index+step) { contiguous=false; break; }
      }
      if(!contiguous) { unavailable++; row.outcomes[horizon]={status:"DATA_GAP"}; continue; }
      const window=candles.slice(index+1,end+1);
      const entry=window[0].open, exit=window[window.length-1].close;
      if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(exit)||exit<=0) {
        unavailable++; row.outcomes[horizon]={status:"INVALID_PRICE"}; continue;
      }
      const direction=record.signal==="BUY"?1:-1;
      const returnPct=direction*(exit/entry-1)*100;
      const favorablePct=Math.max(0,direction===1?
        (Math.max(...window.map(c=>c.high))/entry-1)*100:
        (1-Math.min(...window.map(c=>c.low))/entry)*100);
      const adversePct=Math.max(0,direction===1?
        (1-Math.min(...window.map(c=>c.low))/entry)*100:
        (Math.max(...window.map(c=>c.high))/entry-1)*100);
      const metric=stats[horizon];
      metric.scored++;
      if(returnPct>0) metric.wins++; else if(returnPct<0) metric.losses++; else metric.flats++;
      metric._returns=(metric._returns||0)+returnPct;
      metric._favorable=(metric._favorable||0)+favorablePct;
      metric._adverse=(metric._adverse||0)+adversePct;
      row.outcomes[horizon]={status:"SCORED",entry_price:entry,exit_price:exit,
        return_pct:round4(returnPct),max_favorable_pct:round4(favorablePct),
        max_adverse_pct:round4(adversePct),entry_basis:"next_completed_candle_open"};
    }
    outcomes.push(row);
  }
  for(const horizon of horizons) {
    const m=stats[horizon];
    if(m.scored) {
      m.win_rate_pct=round2(m.wins/m.scored*100);
      m.average_return_pct=round4(m._returns/m.scored);
      m.average_favorable_pct=round4(m._favorable/m.scored);
      m.average_adverse_pct=round4(m._adverse/m.scored);
    }
    delete m._returns; delete m._favorable; delete m._adverse;
  }
  const maximumScoredSamples=Math.max(0,...Object.values(stats).map(item=>item.scored));
  return {method:"completed_60m_candles_next_open_entry",horizons:Object.values(stats),
    outcomes:outcomes.slice(0,50),directional_signals:ordered.length,pending_count:pending,
    unavailable_count:unavailable,
    sample_quality:{minimum_context_samples:30,maximum_scored_samples:maximumScoredSamples,
      status:maximumScoredSamples>=30?"AT_OR_ABOVE_CONTEXT_THRESHOLD":"BELOW_CONTEXT_THRESHOLD",
      note:"30 is a practical display threshold only; it does not establish statistical significance or predict future performance."},
    execution_enabled:false,
    warning:"Historical descriptive evaluation only. Entry is the next completed candle open; no fees, spread, slippage or broker fills are modeled. Small samples are not evidence of future profitability."};
}


async function sha256Hex(value) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
function randomHex(byteLength) {
  const bytes=crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status,headers:{
    "content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "access-control-allow-origin":"*",
    "x-content-type-options":"nosniff",
    "x-frame-options":"DENY",
    "referrer-policy":"no-referrer",
    "permissions-policy":"camera=(), microphone=(), geolocation=()"
  }});
}
function parseStamp(v) {
  if (!v || typeof v !== "string") return null;
  const normalized = /Z|[+-]\d\d:\d\d$/.test(v) ? v : v + "Z";
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
function normalise(item, def, provider="NerkhAra") {
  const [symbol,fallbackName,id,expectedUnit,displayUnit] = def;
  const price=item?.price;
  const validPrice=typeof price==="number" && Number.isFinite(price) && price>0;
  const stamp=parseStamp(item?.updated_utc);
  const age=stamp ? (Date.now()-stamp.getTime())/1000 : null;
  const unitValid=item?.unit===expectedUnit;
  const maxAge=provider==="Talasanj"?TALASANJ_MAX_AGE_SECONDS:MAX_AGE_SECONDS;
  const fresh=Boolean(validPrice && stamp && age>=-30 && age<=maxAge && item?.stale!==true && unitValid);
  return {
    symbol,name:item?.name?.fa || item?.name?.en || fallbackName,
    price:fresh?price:null,unit:displayUnit,source:provider,
    timestamp:stamp?stamp.toISOString():null,
    age_seconds:age===null?null:Math.round(age*10)/10,
    status:fresh?"LIVE":validPrice&&unitValid?"STALE":"UNAVAILABLE",
    meta:{provider_id:id,source_unit:item?.unit??null,unit_valid:unitValid,
      updated_utc:item?.updated_utc??null,change_pct:item?.change_pct??null,
      sources:item?.sources??null,spread_pct:item?.spread_pct??null,
      method:item?.method??null,stale:item?.stale===true,
      reason:fresh?null:"Quote is missing, stale, invalid, or has an unexpected unit"}
  };
}
async function snapshot(env={}) {
  if(cached && Date.now()-cachedAt<(cached.quotes?.[0]?.source==="Talasanj"?15000:60000)) return cached;
  try {
    let payload=await fetchTalasanj(env);
    let provider="Talasanj";
    if(!payload) {
      const response=await fetch(SOURCE,{headers:{accept:"application/json"},cf:{cacheTtl:60,cacheEverything:true}});
      if(!response.ok) throw new Error("Provider HTTP "+response.status);
      payload=await response.json();
      provider="NerkhAra";
    }
    if(!payload || !Array.isArray(payload.items)) throw new Error("Unexpected provider schema");
    const byId=new Map(payload.items.filter(x=>x&&typeof x==="object").map(x=>[x.id,x]));
    const quotes=SYMBOLS.map(def=>normalise(byId.get(def[2]),def,provider));
    cached={status:quotes.some(q=>q.status==="LIVE")?"LIVE":"UNAVAILABLE",
      as_of:new Date().toISOString(),provider_generated_at:parseStamp(payload.generated_utc)?.toISOString()??null,
      quotes,notice:provider==="Talasanj"?"Talasanj indicative market data refreshes about every 20 seconds; not broker execution quotes. Stale or unavailable prices never produce signals.":"NerkhAra refreshes its snapshot every ten minutes. Indicative market data only, not broker execution quotes. Stale or unavailable prices never produce signals.",
      attribution:provider==="Talasanj"?"قیمت‌ها از طلاسنج — https://talasanj.info":"NerkhAra — https://nerkhara.com"};
  } catch(e) {
    cached={status:"UNAVAILABLE",as_of:new Date().toISOString(),provider_generated_at:null,
      quotes:SYMBOLS.map(def=>normalise(null,def)),
      notice:"Market data provider is unavailable. No synthetic prices are displayed.",
      error:String(e?.name||"ProviderError"),attribution:"NerkhAra — https://nerkhara.com"};
  }
  cachedAt=Date.now();
  return cached;
}

async function savePaperMonitorStatus(env, status) {
  if(env?.SIGNAL_HISTORY) {
    await env.SIGNAL_HISTORY.put("paper-monitor:latest",JSON.stringify(status),{expirationTtl:60*60*24*30});
  }
  return status;
}

async function runScheduledPaperMonitor(env, scheduledTime) {
  const startedAt=new Date().toISOString();
  try {
    const registry=env?.PAPER_ACCOUNTS?.getByName("__paper_bootstrap_guard__");
    if(!registry?.listAccountIds) throw new Error("Paper account registry is unavailable");
    const accountIds=await registry.listAccountIds(5000);
    if(!accountIds.length) return await savePaperMonitorStatus(env,{
      status:"IDLE",accounts_checked:0,trades_processed:0,closed_trades:0,
      scheduled_at:new Date(scheduledTime).toISOString(),completed_at:new Date().toISOString(),
      execution_enabled:false,mode:"PAPER_ONLY"
    });
    const market=await fetchGoldCandles("xau","15m");
    if(market.status!=="LIVE"||market.provider!=="XAUS"||!market.candles?.length)
      throw new Error("Fresh completed XAUS 15m candle unavailable; no paper positions were changed");
    const checkedAt=new Date().toISOString();
    let accountsChecked=0,processed=0,closed=0;
    const failures=[];
    for(let offset=0;offset<accountIds.length;offset+=10) {
      const batch=accountIds.slice(offset,offset+10);
      const outcomes=await Promise.allSettled(batch.map(async accountId=>{
        const account=env.PAPER_ACCOUNTS.getByName(accountId);
        const result=await account.monitorTradesInternal("XAUUSD",market.candles,5,checkedAt);
        if(!result) throw new Error("Paper account monitor returned no result");
        return result;
      }));
      for(const outcome of outcomes) {
        if(outcome.status==="rejected") failures.push(String(outcome.reason?.message||outcome.reason));
        else {
          accountsChecked++;
          processed+=outcome.value.processed||0;
          closed+=outcome.value.closed||0;
        }
      }
    }
    if(failures.length) throw new Error("Scheduled paper monitoring partially failed: "+accountsChecked+
      " accounts checked; "+failures.length+" account operations failed");
    return await savePaperMonitorStatus(env,{
      status:"OK",provider:market.provider,symbol:"XAUUSD",interval:"15m",
      candle_at:market.last_candle_at,accounts_checked:accountsChecked,
      trades_processed:processed,closed_trades:closed,
      scheduled_at:new Date(scheduledTime).toISOString(),started_at:startedAt,
      completed_at:new Date().toISOString(),execution_enabled:false,mode:"PAPER_ONLY"
    });
  } catch(error) {
    await savePaperMonitorStatus(env,{
      status:"ERROR",scheduled_at:new Date(scheduledTime).toISOString(),
      started_at:startedAt,completed_at:new Date().toISOString(),
      error:String(error?.message||"Scheduled paper monitor failed").slice(0,300),
      execution_enabled:false,mode:"PAPER_ONLY"
    }).catch(()=>{});
    throw error;
  }
}

export default {
  async scheduled(controller, env) {
    return runScheduledPaperMonitor(env,controller.scheduledTime);
  },
  async fetch(request, env) {
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{headers:{
      "access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS",
      "access-control-allow-headers":"content-type,authorization",
      "access-control-max-age":"86400",
      "x-content-type-options":"nosniff",
      "x-frame-options":"DENY",
      "referrer-policy":"no-referrer",
      "permissions-policy":"camera=(), microphone=(), geolocation=()"}});
    if(url.pathname==="/v1/paper/accounts"&&request.method==="POST") {
      try {
        const contentLength=Number(request.headers.get("content-length")||0);
        if(contentLength>2048) return json({error:"Account creation payload is too large"},413);
        const payload=await request.json();
        if(!payload||typeof payload!=="object"||Array.isArray(payload))
          return json({error:"Request body must be a JSON object"},400);
        const startingCapital=payload.starting_capital??10000;
        const currency=payload.currency??"USD";
        if(typeof startingCapital!=="number"||!Number.isFinite(startingCapital)||
          startingCapital<=0||startingCapital>1_000_000_000||
          !["USD","IRT"].includes(currency))
          return json({error:"starting_capital must be a finite positive JSON number <= 1,000,000,000 and currency must be USD or IRT"},400);
        const clientIp=request.headers.get("cf-connecting-ip");
        if(!clientIp) return json({error:"Client address unavailable; account creation is blocked"},400);
        const ipHash=await sha256Hex(clientIp);
        const day=new Date().toISOString().slice(0,10);
        const bootstrap=env.PAPER_ACCOUNTS.getByName("__paper_bootstrap_guard__");
        if(!await bootstrap.allowCreation(ipHash,day))
          return json({error:"Daily paper-account creation limit reached for this network"},429);
        const accountId=randomHex(16),accessToken=randomHex(32),tokenHash=await sha256Hex(accessToken);
        const createdAt=new Date().toISOString();
        const account=env.PAPER_ACCOUNTS.getByName(accountId);
        const created=await account.createAccount(accountId,tokenHash,currency,startingCapital,createdAt);
        await bootstrap.registerAccount(accountId,createdAt);
        return json({...created,access_token:accessToken,token_type:"Bearer",
          token_notice:"This token is shown once. Store it securely; it cannot be recovered.",
          execution_enabled:false},201);
      } catch(e) {
        return json({error:String(e?.message||"Paper account creation unavailable")},503);
      }
    }
    const paperMonitorMatch=url.pathname.match(/^\/v1\/paper\/accounts\/([a-f0-9]{32})\/monitor$/);
    if(paperMonitorMatch&&request.method==="POST") {
      const accountId=paperMonitorMatch[1];
      const auth=request.headers.get("authorization")||"";
      if(!auth.startsWith("Bearer ")) return json({error:"Bearer authorization required"},401);
      const bearer=auth.slice(7);
      if(bearer.length<32||bearer.length>256) return json({error:"Invalid bearer token"},401);
      const tokenHash=await sha256Hex(bearer);
      const symbol="XAUUSD";
      try {
        const market=await fetchGoldCandles("xau","15m");
        const candle=market.candles[market.candles.length-1];
        const account=env.PAPER_ACCOUNTS.getByName(accountId);
        const result=await account.monitorTrades(tokenHash,symbol,candle,5,new Date().toISOString());
        if(result===null) return json({error:"Account not found or access denied"},404);
        await env.PAPER_ACCOUNTS.getByName("__paper_bootstrap_guard__").registerAccount(accountId,new Date().toISOString());
        return json({...result,symbol,provider:market.provider,market_data_status:market.status,
          market_candle_at:market.last_candle_at,mode:"PAPER_ONLY",execution_enabled:false});
      } catch(e) {
        return json({error:String(e?.message||"Paper trade monitoring unavailable"),
          status:"UNAVAILABLE",execution_enabled:false},502);
      }
    }
    const paperAccountAuxMatch=url.pathname.match(/^\/v1\/paper\/accounts\/([a-f0-9]{32})\/(notifications|report\/daily|report\/performance)$/);
    if(paperAccountAuxMatch&&request.method==="GET") {
      const accountId=paperAccountAuxMatch[1],resource=paperAccountAuxMatch[2];
      const auth=request.headers.get("authorization")||"";
      if(!auth.startsWith("Bearer ")) return json({error:"Bearer authorization required"},401);
      const bearer=auth.slice(7);
      if(bearer.length<32||bearer.length>256) return json({error:"Invalid bearer token"},401);
      const tokenHash=await sha256Hex(bearer);
      const account=env.PAPER_ACCOUNTS.getByName(accountId);
      try {
        if(resource==="notifications") {
          const notifications=await account.listNotifications(tokenHash,30);
          if(notifications===null) return json({error:"Account not found or access denied"},404);
          return json({notifications,execution_enabled:false,mode:"PAPER_ONLY"});
        }
        const day=url.searchParams.get("date")||new Date().toISOString().slice(0,10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+"T00:00:00.000Z"))||
          new Date(Date.parse(day+"T00:00:00.000Z")).toISOString().slice(0,10)!==day)
          return json({error:"date must be a valid YYYY-MM-DD UTC date"},400);
        if(resource==="report/performance") {
          const period=url.searchParams.get("period")||"week";
          if(!["week","month"].includes(period)) return json({error:"period must be week or month"},400);
          const report=await account.getPerformanceReport(tokenHash,period,day);
          if(report===null) return json({error:"Account not found or access denied"},404);
          return json(report);
        }
        const report=await account.getDailyReport(tokenHash,day);
        if(report===null) return json({error:"Account not found or access denied"},404);
        return json(report);
      } catch(e) {
        return json({error:String(e?.message||"Paper account report unavailable"),execution_enabled:false},503);
      }
    }
    const paperAccountMatch=url.pathname.match(/^\/v1\/paper\/accounts\/([a-f0-9]{32})(?:\/(trades)(?:\/([a-f0-9]{32})\/close)?)?$/);
    if(paperAccountMatch) {
      const accountId=paperAccountMatch[1],isTrades=paperAccountMatch[2]==="trades",closeId=paperAccountMatch[3];
      const auth=request.headers.get("authorization")||"";
      if(!auth.startsWith("Bearer ")) return json({error:"Bearer authorization required"},401);
      const bearer=auth.slice(7);
      if(bearer.length<32||bearer.length>256) return json({error:"Invalid bearer token"},401);
      const tokenHash=await sha256Hex(bearer);
      const account=env.PAPER_ACCOUNTS.getByName(accountId);
      if(request.method==="GET"&&!isTrades&&!closeId) {
        try { const summary=await account.getSummary(tokenHash);
          if(summary===null) return json({error:"Account not found or access denied"},404);
          return json(summary);
        } catch(e) { return json({error:String(e?.message||"Paper account unavailable")},503); }
      }
      if(request.method==="GET"&&isTrades&&!closeId) {
        try { const trades=await account.listTrades(tokenHash,50);
          if(trades===null) return json({error:"Account not found or access denied"},404);
          return json({trades,execution_enabled:false});
        } catch(e) { return json({error:String(e?.message||"Paper trade journal unavailable")},503); }
      }
      if(request.method==="POST"&&isTrades&&!closeId) {
        try {
          const length=Number(request.headers.get("content-length")||0);
          if(length>2048) return json({error:"Trade payload is too large"},413);
          const payload=await request.json();
          if(!payload||typeof payload!=="object"||Array.isArray(payload)) return json({error:"Request body must be a JSON object"},400);
          const {symbol,side,quantity,entry_price,stop_loss,take_profit}=payload;
          const feeBps=payload.fee_bps??5;
          const idem=payload.idempotency_key;
          if(typeof symbol!=="string"||!/^[A-Z0-9._-]{2,32}$/.test(symbol)||
             !["BUY","SELL"].includes(side)||
             ![quantity,entry_price,stop_loss,take_profit,feeBps].every(v=>typeof v==="number"&&Number.isFinite(v))||
             quantity<=0||entry_price<=0||stop_loss<=0||take_profit<=0||feeBps<0||feeBps>1000||
             (side==="BUY"&&(stop_loss>=entry_price||take_profit<=entry_price))||
             (side==="SELL"&&(stop_loss<=entry_price||take_profit>=entry_price))||
             (idem!==undefined&&(typeof idem!=="string"||idem.length<8||idem.length>128)))
            return json({error:"Invalid trade: use positive numeric values, directional stop/target and a valid optional idempotency_key"},400);
          const result=await account.createTrade(tokenHash,{trade_id:randomHex(16),symbol,side,quantity,entry_price,stop_loss,take_profit,fee_bps:feeBps,idempotency_key:idem??null},new Date().toISOString());
          if(result===null) return json({error:"Account not found or access denied"},404);
          if(result.error) return json(result,409);
          return json({...result,mode:"PAPER_ONLY",trading_enabled:false,execution_enabled:false},201);
        } catch(e) {
          const message=String(e?.message||"Paper trade could not be recorded");
          const status=message==="INSUFFICIENT_PAPER_BALANCE"||message==="RISK_LIMIT_EXCEEDED"?409:503;
          return json({error:message,execution_enabled:false},status);
        }
      }
      if(request.method==="POST"&&isTrades&&closeId) {
        try {
          const length=Number(request.headers.get("content-length")||0);
          if(length>1024) return json({error:"Close payload is too large"},413);
          const payload=await request.json();
          const exitPrice=payload?.exit_price,feeBps=payload?.fee_bps??5;
          if(typeof exitPrice!=="number"||!Number.isFinite(exitPrice)||exitPrice<=0||
             typeof feeBps!=="number"||!Number.isFinite(feeBps)||feeBps<0||feeBps>1000)
            return json({error:"exit_price must be a positive JSON number and fee_bps must be between 0 and 1000"},400);
          const result=await account.closeTrade(tokenHash,closeId,exitPrice,feeBps,new Date().toISOString());
          if(result===null) return json({error:"Account not found or access denied"},404);
          if(result.error) return json(result,409);
          return json({...result,mode:"PAPER_ONLY",execution_enabled:false},200);
        } catch(e) { return json({error:String(e?.message||"Paper trade could not be closed"),execution_enabled:false},503); }
      }
      return json({error:"Method not allowed"},405);
    }
    if(url.pathname==="/telegram/webhook" && request.method==="POST")
      return handleTelegramWebhook(request, env, snapshot, json);
    if(url.pathname==="/health") return json({status:"ok",service:"ayyar-smart-trader-api",version:"1.0.0"});
    if(url.pathname==="/v1/paper-trading/simulate"&&request.method==="POST") {
      try {
        const payload=await request.json();
        return json(simulatePaperTrading(payload));
      } catch(e) {
        return json({error:String(e?.message||"Paper simulation failed"),mode:"PAPER_ONLY",
          execution_enabled:false},400);
      }
    }
    if(url.pathname==="/v1/market/quotes"&&request.method==="GET") return json(await snapshot(env));
    if(url.pathname==="/v1/market/history"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol") || "gold-18k";
      if(!HISTORY_IDS.has(symbol)) return json({error:"Unsupported symbol",allowed_symbols:[...HISTORY_IDS]},400);
      const hit=historyCache.get(symbol);
      if(hit && Date.now()-hit.at<HISTORY_TTL_MS) return json(hit.body);
      try {
        const upstream=await fetch(`https://nerkhara.com/api/v1/history/${encodeURIComponent(symbol)}.json`,{
          headers:{accept:"application/json"},cf:{cacheTtl:3600,cacheEverything:true}
        });
        if(!upstream.ok) throw new Error("History provider HTTP "+upstream.status);
        const series=await upstream.json();
        if(!series || typeof series!=="object" || Array.isArray(series) || Object.keys(series).length===0)
          throw new Error("Unexpected history response");
        const body={symbol,source:"NerkhAra",source_url:`https://nerkhara.com/api/v1/history/${symbol}.json`,
          granularity:"1d",value_type:"daily_mean",retrieved_at:new Date().toISOString(),
          note:"Daily mean observations, not intraday OHLC candles or executable prices.",series,
          attribution:"NerkhAra — https://nerkhara.com"};
        historyCache.set(symbol,{at:Date.now(),body});
        return json(body);
      } catch(e) {
        return json({symbol,status:"UNAVAILABLE",error:String(e?.message||"History unavailable"),
          note:"Historical data could not be retrieved; no values have been fabricated."},502);
      }
    }

    if(url.pathname==="/v1/market/regime"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau",interval=url.searchParams.get("interval")||"60m";
      try { const market=await fetchGoldCandles(symbol,interval); return json({...classifyMarketRegime(market.candles),symbol,interval,provider:market.provider,last_candle_at:market.last_candle_at,execution_enabled:false}); }
      catch(e) { return json({status:"UNAVAILABLE",tradeable:false,symbol,interval,reason:String(e?.message||"Market regime unavailable"),execution_enabled:false},502); }
    }
    if(url.pathname==="/v1/market/candles"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      try { return json(await fetchGoldCandles(symbol,interval)); }
      catch(e) { return json({symbol,interval,status:"UNAVAILABLE",candles:[],
        error:String(e?.message||"OHLC data unavailable"),
        execution_enabled:false,
        note:"No synthetic candles are generated. Signals remain disabled when real completed OHLC data is unavailable."},502); }
    }
    if(url.pathname==="/v1/signals/multi-timeframe"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const intervals=["15m","60m","1d"];
      try {
        const markets=await Promise.all(intervals.map(interval=>fetchGoldCandles(symbol,interval)));
        const analyses=markets.map((market,i)=>evaluateSignal({
          candles:market.candles,timeframe_minutes:market.interval_seconds/60
        }));
        const byInterval=Object.fromEntries(intervals.map((interval,i)=>[interval,{
          signal:analyses[i].signal,trend:analyses[i].trend,
          confidence:analyses[i].confidence,last_candle_at:markets[i].last_candle_at,
          data_status:markets[i].status
        }]));
        const regimes=markets.map(market=>classifyMarketRegime(market.candles));
        for(let i=0;i<intervals.length;i++) byInterval[intervals[i]].regime=regimes[i];
        const intraday=analyses[1].signal;
        const shortAligned=analyses[0].signal===intraday;
        const regimeAllowsTrade=regimes[1].tradeable&&regimes[1].trend===(intraday==="BUY"?"BULLISH":"BEARISH");
        const expectedTrend=intraday==="BUY"?"BULLISH":"BEARISH";
        const trendAligned=analyses.every(analysis=>analysis.trend===expectedTrend);
        const aligned=intraday!=="NO_TRADE"&&shortAligned&&trendAligned&&regimeAllowsTrade;
        const base=analyses[1];
        const result={
          signal:aligned?intraday:"NO_TRADE",
          confidence:aligned?Math.min(analyses[0].confidence,analyses[1].confidence,analyses[2].confidence):0,
          confidence_type:"multi_timeframe_alignment_score_not_probability",
          trend:base.trend,rsi_14:base.rsi_14,macd_histogram:base.macd_histogram,atr_14:base.atr_14,
          entry:aligned?base.entry:null,stop_loss:aligned?base.stop_loss:null,
          take_profit:aligned?base.take_profit:null,risk_reward_ratio:aligned?2:null,
          timeframes:byInterval,market_data_status:"LIVE",
          market_provider:"XAUS",market_source_url:"https://xaus.com/api/v1/chart",
          last_candle_at:markets[1].last_candle_at,
          market_regime:regimes[1],
          reasons:aligned?["15m and 60m signals agree","15m, 60m and daily EMA trends all confirm direction","60m market regime is trending and volatility is within limits","Entry levels use the 60m candle"]:[!regimes[1].tradeable?regimes[1].reason:"Signal or EMA trend is not aligned across 15m, 60m and daily charts; wait for confirmation."],
          execution_enabled:false,
          warning:"Multi-timeframe research signal only. Indicative global XAU/USD data; no broker orders are placed."
        };
        try {
          const archive=await archiveSignal(env,symbol,result);
          result.archive_status=archive.saved?"SAVED":"SKIPPED";
          result.alert_status=archive.alert_status;
        } catch { result.archive_status="UNAVAILABLE";result.alert_status="UNAVAILABLE"; }
        return json(result);
      } catch(e) {
        return json({signal:"NO_TRADE",confidence:0,data_status:"UNAVAILABLE",
          reason:String(e?.message||"Multi-timeframe OHLC data unavailable"),
          execution_enabled:false,
          warning:"All three real completed timeframes are required. No synthetic candles or orders are produced."});
      }
    }
    if(url.pathname==="/v1/signals/performance"&&request.method==="GET") {
      if(!env?.SIGNAL_HISTORY) return json({status:"UNAVAILABLE",error:"Signal history storage is not configured",execution_enabled:false},503);
      try {
        const listed=await env.SIGNAL_HISTORY.list({prefix:"xau:latest:",limit:1000});
        const records=(await Promise.all(listed.keys.map(item=>env.SIGNAL_HISTORY.get(item.name,"json")))).filter(Boolean);
        const market=await fetchGoldCandles("xau","60m");
        const result=calculateSignalPerformance(records,market.candles);
        return json({status:"OK",symbol:"xau",provider:market.provider,market_last_candle_at:market.last_candle_at,
          candle_data_quality:market.data_quality,record_count:records.length,...result});
      } catch(e) {
        return json({status:"UNAVAILABLE",error:String(e?.message||"Signal performance evaluation unavailable"),
          execution_enabled:false},502);
      }
    }
    if(url.pathname==="/v1/signals/history"&&request.method==="GET") {
      if(!env?.SIGNAL_HISTORY) return json({status:"UNAVAILABLE",records:[],error:"Signal history storage is not configured"},503);
      const requested=Number(url.searchParams.get("limit")||50);
      const limit=Number.isInteger(requested)?Math.max(1,Math.min(100,requested)):50;
      try {
        const listed=await env.SIGNAL_HISTORY.list({prefix:"xau:latest:",limit});
        const records=await Promise.all(listed.keys.map(async item=>{
          const value=await env.SIGNAL_HISTORY.get(item.name,"json");
          return value&&typeof value==="object"?value:null;
        }));
        const valid=records.filter(Boolean).sort((a,b)=>Date.parse(b.recorded_at)-Date.parse(a.recorded_at));
        return json({status:"OK",symbol:"xau",count:valid.length,records:valid,
          retention_days:90,execution_enabled:false});
      } catch(e) {
        return json({status:"UNAVAILABLE",records:[],error:String(e?.message||"Signal history read failed")},503);
      }
    }
    if(url.pathname==="/v1/signals/latest"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const evaluated=evaluateSignal({candles:market.candles,timeframe_minutes:market.interval_seconds/60});
        return json({...evaluated,market_symbol:symbol,market_provider:market.provider,
          market_provider_symbol:market.provider_symbol,market_source_url:market.source_url,market_last_candle_at:market.last_candle_at,
          market_data_status:market.status,execution_enabled:false});
      } catch(e) {
        return json({signal:"NO_TRADE",confidence:0,data_status:"UNAVAILABLE",
          reason:String(e?.message||"OHLC data unavailable"),execution_enabled:false,
          warning:"No valid completed OHLC feed. No signal or order is produced."});
      }
    }
    if(url.pathname==="/v1/paper/monitor/status"&&request.method==="GET") {
      if(!env?.SIGNAL_HISTORY) return json({status:"UNAVAILABLE",error:"Monitor status storage is not configured",execution_enabled:false},503);
      try {
        const record=await env.SIGNAL_HISTORY.get("paper-monitor:latest","json");
        return json({status:record?.status||"NOT_RUN",monitor:record||null,
          schedule:"*/5 * * * * UTC",monitor_interval:"15m completed candles",
          execution_enabled:false,mode:"PAPER_ONLY"});
      } catch(e) {
        return json({status:"UNAVAILABLE",error:"Monitor status could not be read",execution_enabled:false},503);
      }
    }
    if(url.pathname==="/v1/market/status"&&request.method==="GET") {
      const s=await snapshot(env);
      return json({status:s.status,as_of:s.as_of,live_quotes:s.quotes.filter(q=>q.status==="LIVE").length,
        total_quotes:s.quotes.length,attribution:s.attribution});
    }
    if(url.pathname==="/v1/risk/policy"&&request.method==="GET") return json({
      default_risk_per_trade:0.01,max_daily_loss:0.03,max_drawdown:0.08,execution_enabled:false,
      note:"Policy defaults only. No broker connection or automatic order execution."});
    if(url.pathname==="/v1/risk/portfolio-check"&&request.method==="POST") {
      try {
        const p=await request.json();
        const equity=Number(p.equity),dayStart=Number(p.day_start_equity),peak=Number(p.peak_equity);
        const proposedRisk=Number(p.proposed_risk_fraction??0.01),maxOpenRisk=Number(p.max_open_risk_fraction??0.02);
        const maxPositions=Number(p.max_positions??3),positions=p.open_positions??[];
        if(![equity,dayStart,peak,proposedRisk,maxOpenRisk,maxPositions].every(Number.isFinite)||equity<=0||dayStart<=0||peak<=0||proposedRisk<=0||proposedRisk>0.01||maxOpenRisk<=0||maxOpenRisk>0.02||!Number.isInteger(maxPositions)||maxPositions<1||maxPositions>10||!Array.isArray(positions)||positions.length>10||positions.some(x=>!Number.isFinite(Number(x?.risk_amount))||Number(x.risk_amount)<0)) return json({error:"Invalid portfolio risk inputs"},400);
        const dailyLoss=Math.max(0,(dayStart-equity)/dayStart),drawdown=Math.max(0,(peak-equity)/peak);
        const openRisk=positions.reduce((sum,x)=>sum+Number(x.risk_amount),0),proposedRiskAmount=equity*proposedRisk;
        const aggregateRisk=openRisk+proposedRiskAmount;
        if(![openRisk,proposedRiskAmount,aggregateRisk,equity*maxOpenRisk].every(Number.isFinite))
          return json({error:"Portfolio risk calculation overflow; verify account and exposure values."},400);
        let reason="Account figures are manually supplied and are not authenticated by a broker; new positions remain blocked.";
        if(dailyLoss>=0.03) reason="Daily loss limit reached (3%); new positions are blocked.";
        else if(drawdown>=0.08) reason="Peak-to-current drawdown limit reached (8%); new positions are blocked.";
        else if(positions.length>=maxPositions) reason="Maximum number of concurrent positions reached.";
        else if(aggregateRisk>equity*maxOpenRisk+1e-8) reason="Aggregate open plus proposed risk exceeds the portfolio risk cap.";
        return json({allowed:false,status:"UNVERIFIED_ACCOUNT_DATA",data_verified:false,reason,equity,daily_loss_fraction:round4(dailyLoss),drawdown_fraction:round4(drawdown),open_positions:positions.length,open_risk_amount:round4(openRisk),proposed_risk_amount:round4(proposedRiskAmount),aggregate_risk_amount:round4(aggregateRisk),aggregate_risk_fraction:round4(aggregateRisk/equity),max_open_risk_fraction:maxOpenRisk,max_positions:maxPositions,execution_enabled:false,note:"Calculations are informational only. No authenticated broker/account feed is connected, so this endpoint never authorizes a trade."});
      } catch { return json({error:"Request body must be valid JSON"},400); }
    }
    if(url.pathname==="/v1/risk/position-size"&&request.method==="POST") {
      try {
        const p=await request.json();
        const numeric=(value)=>typeof value==="number"&&Number.isFinite(value);
        const equity=p.equity,entry=p.entry,stop=p.stop_loss;
        const contract=p.contract_value_per_price_unit;
        const risk=p.risk_fraction??0.01,daily=p.daily_loss_fraction??0,drawdown=p.drawdown_fraction??0;
        const lotStep=p.lot_step??0.01,minLot=p.min_lot??lotStep;
        const maxLot=p.max_lot===undefined?Number.MAX_SAFE_INTEGER:p.max_lot;
        if(![equity,entry,stop,contract,risk,daily,drawdown,lotStep,minLot,maxLot].every(numeric) ||
           equity<=0||entry<=0||stop<=0||contract<=0||risk<=0||risk>0.01||daily<0||daily>1||drawdown<0||drawdown>1||entry===stop||
           lotStep<=0||lotStep>1000||minLot<lotStep||maxLot<minLot||
           Math.abs(minLot/lotStep-Math.round(minLot/lotStep))>1e-8)
          return json({error:"Invalid position sizing inputs; all monetary, risk and lot fields must be finite JSON numbers and broker lot limits must align to the lot step."},400);
        if(daily>=0.03) return json({allowed:false,lots:0,reason:"Daily loss limit reached; trading is blocked."});
        if(drawdown>=0.08) return json({allowed:false,lots:0,reason:"Maximum drawdown limit reached; trading is blocked."});
        const effectiveRisk=Math.min(risk,0.01),riskAmount=equity*effectiveRisk;
        const stopDistance=Math.abs(entry-stop),lossPerLot=stopDistance*contract;
        const rawLots=riskAmount/lossPerLot;
        if(!Number.isFinite(riskAmount)||!Number.isFinite(stopDistance)||!Number.isFinite(lossPerLot)||lossPerLot<=0||!Number.isFinite(rawLots)||rawLots<=0)
          return json({error:"Position sizing overflow or underflow; review equity, stop distance, and contract value."},400);
        const steppedLots=Math.floor((rawLots+lotStep*1e-10)/lotStep)*lotStep;
        const brokerMaxLots=Math.floor((maxLot+lotStep*1e-10)/lotStep)*lotStep;
        const lots=Number(Math.min(steppedLots,brokerMaxLots).toFixed(8));
        if(!Number.isFinite(lots)||lots<minLot)
          return json({allowed:false,lots:0,raw_lots:rawLots,risk_amount:riskAmount,
            reason:"Calculated size is below the broker minimum lot after rounding down; trade is blocked."});
        const estimatedLoss=lots*lossPerLot;
        if(!Number.isFinite(estimatedLoss)||estimatedLoss<=0||estimatedLoss>riskAmount*(1+1e-9))
          return json({error:"Rounded position size exceeds the configured risk budget."},400);
        return json({allowed:true,lots,raw_lots:rawLots,lot_step:lotStep,min_lot:minLot,max_lot:maxLot,
          risk_amount:riskAmount,risk_fraction:effectiveRisk,stop_distance:stopDistance,
          estimated_loss_at_stop:estimatedLoss,unused_risk_budget:Math.max(0,riskAmount-estimatedLoss),
          reason:"Sizing estimate only. Lots are rounded down to the broker step; confirm tick value, margin, spread and broker rules before any order."});
      } catch { return json({error:"Request body must be valid JSON"},400); }
    }
    if(url.pathname==="/v1/backtest/ema-crossover/live"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      const readNumber=(key,fallback)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):fallback;
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const result=runBacktest({
          candles:market.candles,
          starting_capital:readNumber("starting_capital",10000),
          fee_bps:readNumber("fee_bps",10),
          slippage_bps:readNumber("slippage_bps",5)
        });
        return json({...result,market_symbol:symbol,market_provider:market.provider,
          market_source_url:market.source_url,market_interval:market.interval,
          market_data_status:market.status,market_retrieved_at:market.retrieved_at,
          market_last_candle_at:market.last_candle_at,candle_count:market.candles.length,
          data_note:market.note});
      } catch(e) {
        return json({status:"UNAVAILABLE",market_symbol:symbol,market_interval:interval,
          error:String(e?.message||"Live OHLC backtest unavailable"),
          execution_enabled:false,
          note:"A live backtest requires valid completed provider OHLC candles. No synthetic or daily-mean data is substituted."},502);
      }
    }
    if(url.pathname==="/v1/backtest/ema-crossover/compare"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const intervals=["15m","30m","60m","1d"];
      const strategies=[[9,21],[12,26],[20,50]];
      const markets=await Promise.all(intervals.map(async interval=>{
        try {
          const market=await fetchGoldCandles(symbol,interval);
          const results=strategies.map(([fast,slow])=>{
            try {
              const result=runBacktest({candles:market.candles,fast_period:fast,slow_period:slow,
                starting_capital:10000,fee_bps:10,slippage_bps:5});
              return {fast_period:fast,slow_period:slow,status:"OK",net_return_pct:result.net_return_pct,
                max_drawdown_pct:result.max_drawdown_pct,closed_trades:result.closed_trades,
                win_rate_pct:result.win_rate_pct,profit_factor:result.profit_factor,
                final_equity:result.final_equity,open_position:result.open_position};
            } catch(e) {
              return {fast_period:fast,slow_period:slow,status:"INSUFFICIENT_DATA",error:String(e?.message||"Backtest unavailable")};
            }
          });
          return {interval,status:"LIVE",provider:market.provider,last_candle_at:market.last_candle_at,
            candle_count:market.candles.length,results};
        } catch(e) {
          return {interval,status:"UNAVAILABLE",error:String(e?.message||"OHLC data unavailable"),results:[]};
        }
      }));
      return json({symbol,strategies:strategies.map(([fast,slow])=>({fast_period:fast,slow_period:slow})),
        intervals:markets,starting_capital:10000,cost_model:{fee_bps_per_side:10,slippage_bps_per_side:5},
        warning:"Research comparison only. Different intervals have different sample lengths; metrics are not directly equivalent and do not predict future results. Long-only simulation; no broker execution."});
    }
    if(url.pathname==="/v1/backtest/walk-forward"&&request.method==="POST") {
      try { return json(runWalkForward(await request.json())); }
      catch(e) { return json({error:String(e?.message||"Invalid walk-forward request"),execution_enabled:false},400); }
    }
    if(url.pathname==="/v1/backtest/walk-forward/live"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const result=runWalkForward({candles:market.candles,
          starting_capital:url.searchParams.has("starting_capital")?Number(url.searchParams.get("starting_capital")):10000,
          fee_bps:url.searchParams.has("fee_bps")?Number(url.searchParams.get("fee_bps")):10,
          slippage_bps:url.searchParams.has("slippage_bps")?Number(url.searchParams.get("slippage_bps")):5});
        return json({...result,market_symbol:symbol,market_provider:market.provider,
          market_interval:market.interval,market_data_status:market.status,
          market_last_candle_at:market.last_candle_at,candle_count:market.candles.length,
          data_note:market.note});
      } catch(e) {
        return json({status:"UNAVAILABLE",market_symbol:symbol,market_interval:interval,
          error:String(e?.message||"Walk-forward data unavailable"),execution_enabled:false},502);
      }
    }
    if(url.pathname==="/v1/backtest/ema-crossover"&&request.method==="POST") {
      try { return json(runBacktest(await request.json())); }
      catch(e) { return json({error:String(e?.message||"Invalid backtest request")},400); }
    }
    if(url.pathname==="/v1/signals/evaluate"&&request.method==="POST") {
      try { return json(evaluateSignal(await request.json())); }
      catch(e) { return json({error:String(e?.message||"Invalid signal request"),signal:"NO_TRADE",execution_enabled:false},400); }
    }
    return json({error:"Not found"},404);
  }
};