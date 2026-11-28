import { handleTelegramWebhook } from "./telegram.js";
import { fetchTalasanj } from "./providers.js";
import { simulatePaperTrading } from "./paper.js";
const SOURCE = "https://nerkhara.com/api/v1/latest.json";
const MAX_AGE_SECONDS = 660;
const TALASANJ_MAX_AGE_SECONDS = 90;
const XAUS_MAX_AGE_SECONDS = 120;
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
function inspectCandleContinuity(candles, requestedTimeframeMinutes) {
  if(!Array.isArray(candles)||candles.length<2)
    return {status:"INSUFFICIENT_DATA",timeframe_minutes:null,timeframe_inferred:false};
  const timestampMs=value=>typeof value==="number"?value:Date.parse(value);
  const deltas=candles.slice(1).map((c,i)=>timestampMs(c.timestamp)-timestampMs(candles[i].timestamp));
  if(deltas.some(delta=>!Number.isFinite(delta)||delta<=0))
    return {status:"MISALIGNED",timeframe_minutes:null,timeframe_inferred:false};
  const inferred=requestedTimeframeMinutes===undefined||requestedTimeframeMinutes===null;
  const timeframeMinutes=inferred?Math.min(...deltas)/60000:Number(requestedTimeframeMinutes);
  if(!Number.isFinite(timeframeMinutes)||timeframeMinutes<=0||timeframeMinutes>10080)
    throw new Error("timeframe_minutes must be positive and no greater than 10080");
  const intervalMs=timeframeMinutes*60000;
  let gaps=0,misaligned=0,largestGapIntervals=0;
  for(const delta of deltas){
    const count=Math.round(delta/intervalMs);
    if(count<1||Math.abs(delta-count*intervalMs)>Math.max(1000,intervalMs*0.01)){
      misaligned++;
      continue;
    }
    if(count!==1){gaps++;largestGapIntervals=Math.max(largestGapIntervals,count-1);}
  }
  return {status:misaligned?"MISALIGNED":gaps?"GAPPED":"CLEAN",
    timeframe_minutes:timeframeMinutes,timeframe_inferred:inferred,
    gap_count:gaps,misaligned_interval_count:misaligned,
    largest_gap_intervals:largestGapIntervals};
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
  const continuity=inspectCandleContinuity(candles,payload.timeframe_minutes);
  if(continuity.status!=="CLEAN")
    throw new Error("Backtest candle history is "+continuity.status.toLowerCase()+"; missing or irregular intervals are not bridged");
  const starting = Number(payload.starting_capital ?? 10000);
  const fee = Number(payload.fee_bps ?? 10);
  const slippage = Number(payload.slippage_bps ?? 5);
  const spread = Number(payload.spread_bps ?? 0);
  if (!Number.isFinite(starting)||starting<=0||!Number.isFinite(fee)||fee<0||fee>500||
      !Number.isFinite(slippage)||slippage<0||slippage>500||!Number.isFinite(spread)||spread<0||spread>500)
    throw new Error("starting_capital must be positive and within the supported numeric range; fee/slippage/spread must be between 0 and 500 bps");
  const evaluationStart=Number(payload.evaluation_start_index??0);
  if(!Number.isInteger(evaluationStart)||evaluationStart<0||evaluationStart>candles.length-2||
     (evaluationStart>0&&evaluationStart<slowPeriod+1))
    throw new Error("evaluation_start_index must be zero or at least slow_period + 1 and leave at least one evaluation candle");
  const closes=candles.map(c=>c.close), slow=ema(closes,slowPeriod), fastAligned=ema(closes,fastPeriod).slice(slowPeriod-fastPeriod);
  // spread_bps is the full quoted bid/ask spread; each side pays half.
  const cost=(fee+slippage+spread/2)/10000;
  let cash=starting, quantity=0, entryPrice=null, entryTime=null;
  const trades=[], equityCurve=[{timestamp:candles[Math.max(0,evaluationStart-1)].iso,equity:round2(starting)}];
  // Indicators use only candles available before each decision. In walk-forward
  // mode, pre-test candles warm the indicators but are excluded from test P&L.
  for(let candleIndex=Math.max(1,evaluationStart);candleIndex<candles.length;candleIndex++){
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
    const equity=quantity===0?cash:quantity*candles[candleIndex].close*(1-cost);
    if(!Number.isFinite(equity)||equity<=0)
      throw new Error("Backtest equity is outside the supported numeric range");
    equityCurve.push({timestamp:candles[candleIndex].iso,equity:round2(equity)});
  }
  const finalEquity=quantity===0?cash:quantity*candles[candles.length-1].close*(1-cost);
  if(!Number.isFinite(finalEquity)||finalEquity<=0)
    throw new Error("Final backtest equity is outside the supported numeric range");
  let peak=starting,maxDrawdown=0,maxDrawdownPeakIndex=0,maxDrawdownTroughIndex=0;
  let peakIndex=0,underwaterRun=0,longestUnderwater=0,ulcerSquares=0;
  const drawdownSeries=[];
  for(let i=0;i<equityCurve.length;i++){
    const point=equityCurve[i];
    if(point.equity>=peak){peak=point.equity;peakIndex=i;underwaterRun=0;}
    else {
      const drawdown=(peak-point.equity)/peak;
      underwaterRun++;longestUnderwater=Math.max(longestUnderwater,underwaterRun);
      if(drawdown>maxDrawdown){
        maxDrawdown=drawdown;maxDrawdownPeakIndex=peakIndex;maxDrawdownTroughIndex=i;
      }
    }
    const currentDrawdown=peak>0?Math.max(0,(peak-point.equity)/peak):0;
    drawdownSeries.push(currentDrawdown);
    ulcerSquares+=currentDrawdown*currentDrawdown;
  }
  let recoveryIndex=null;
  const drawdownPeakEquity=equityCurve[maxDrawdownPeakIndex]?.equity??starting;
  if(maxDrawdown>0){
    for(let i=maxDrawdownTroughIndex+1;i<equityCurve.length;i++){
      if(equityCurve[i].equity>=drawdownPeakEquity){recoveryIndex=i;break;}
    }
  } else recoveryIndex=maxDrawdownPeakIndex;
  const drawdownDiagnostics={
    max_drawdown_peak_at:equityCurve[maxDrawdownPeakIndex]?.timestamp??null,
    max_drawdown_trough_at:equityCurve[maxDrawdownTroughIndex]?.timestamp??null,
    max_drawdown_recovered:recoveryIndex!==null,
    max_drawdown_recovery_at:recoveryIndex===null?null:equityCurve[recoveryIndex]?.timestamp??null,
    max_drawdown_recovery_candles:recoveryIndex===null?null:recoveryIndex-maxDrawdownTroughIndex,
    longest_underwater_candles:longestUnderwater,
    underwater_candle_share_pct:round2(drawdownSeries.filter(v=>v>0).length/drawdownSeries.length*100),
    ulcer_index_pct:round4(Math.sqrt(ulcerSquares/drawdownSeries.length)*100),
    note:"Drawdown is marked to market on every candle after estimated transaction costs. Recovery means equity returns to the prior peak; an unrecovered drawdown is reported as null duration."
  };
  const wins=trades.filter(t=>t.pnl>0).length;
  const winningTrades=trades.filter(t=>t.pnl>0),losingTrades=trades.filter(t=>t.pnl<0);
  const profit=winningTrades.reduce((a,t)=>a+t.pnl,0);
  const loss=Math.abs(losingTrades.reduce((a,t)=>a+t.pnl,0));
  let currentLossStreak=0,longestLossStreak=0,currentWinStreak=0,longestWinStreak=0;
  let currentLossRunPnl=0,worstConsecutiveLossPnl=0;
  for(const trade of trades){
    if(trade.pnl<0){
      currentLossStreak++;longestLossStreak=Math.max(longestLossStreak,currentLossStreak);
      currentWinStreak=0;currentLossRunPnl+=trade.pnl;
      worstConsecutiveLossPnl=Math.min(worstConsecutiveLossPnl,currentLossRunPnl);
    } else if(trade.pnl>0){
      currentWinStreak++;longestWinStreak=Math.max(longestWinStreak,currentWinStreak);
      currentLossStreak=0;currentLossRunPnl=0;
    } else {
      currentLossStreak=0;currentWinStreak=0;currentLossRunPnl=0;
    }
  }
  const streakDiagnostics={
    losing_trades:losingTrades.length,winning_trades:winningTrades.length,
    longest_consecutive_losses:longestLossStreak,current_consecutive_losses:currentLossStreak,
    longest_consecutive_wins:longestWinStreak,current_consecutive_wins:currentWinStreak,
    average_loss:losingTrades.length?round2(-loss/losingTrades.length):0,
    worst_single_trade_pnl:trades.length?round2(Math.min(...trades.map(t=>t.pnl))):0,
    worst_consecutive_loss_run_pnl:round2(worstConsecutiveLossPnl),
    note:"Streaks use closed trades in chronological order. Zero-PnL trades reset both streaks. These are historical diagnostics, not a forecast of the next losing streak."
  };
  return {strategy:`EMA${fastPeriod}/EMA${slowPeriod} long-only crossover`,fast_period:fastPeriod,slow_period:slowPeriod,
    execution:"Signal confirmed at candle close; orders filled at next candle open",
    evaluation_start_index:evaluationStart,evaluation_start_at:candles[evaluationStart].iso,
    cost_model:{fee_bps_per_side:fee,slippage_bps_per_side:slippage,spread_bps_full:spread,spread_bps_per_side:spread/2},
    timeframe_minutes:continuity.timeframe_minutes,timeframe_inferred:continuity.timeframe_inferred,
    data_quality:{status:continuity.status,gap_count:continuity.gap_count,
      misaligned_interval_count:continuity.misaligned_interval_count,
      largest_gap_intervals:continuity.largest_gap_intervals},
    starting_capital:round2(starting),final_equity:round2(finalEquity),
    net_return_pct:round4((finalEquity/starting-1)*100),
    max_drawdown_pct:round4(maxDrawdown*100),drawdown_diagnostics:drawdownDiagnostics,closed_trades:trades.length,
    win_rate_pct:trades.length?round2(wins/trades.length*100):0,
    profit_factor:loss>0?round4(profit/loss):profit>0?"infinity":null,
    streak_diagnostics:streakDiagnostics,
    open_position:quantity>0,
    unrealized_pnl:round2(quantity>0?finalEquity-quantity*entryPrice:0),
    trades,equity_curve:equityCurve,
    warning:"Research only. Requires reliable OHLC candles; excludes taxes, funding, market impact, gaps beyond next-open fills, and broker constraints. Not a trading recommendation."};
}


function runAtrRiskBacktest(payload) {
  const fastPeriod=Number(payload?.fast_period??20),slowPeriod=Number(payload?.slow_period??50);
  const atrPeriod=Number(payload?.atr_period??14),stopMultiple=Number(payload?.atr_stop_multiple??2);
  const rewardMultiple=Number(payload?.reward_risk_multiple??1.5);
  const riskFraction=Number(payload?.risk_fraction??0.01);
  if(!Number.isInteger(fastPeriod)||!Number.isInteger(slowPeriod)||fastPeriod<2||slowPeriod<=fastPeriod||slowPeriod>200)
    throw new Error("fast_period and slow_period must satisfy 2 <= fast_period < slow_period <= 200");
  if(!Number.isInteger(atrPeriod)||atrPeriod<2||atrPeriod>100)
    throw new Error("atr_period must be an integer from 2 to 100");
  if(!Number.isFinite(stopMultiple)||stopMultiple<0.5||stopMultiple>10||
     !Number.isFinite(rewardMultiple)||rewardMultiple<0.5||rewardMultiple>10||
     !Number.isFinite(riskFraction)||riskFraction<=0||riskFraction>0.01)
    throw new Error("ATR multiples must be 0.5-10 and risk_fraction must be greater than 0 and no greater than 0.01");
  if(!payload||!Array.isArray(payload.candles)||payload.candles.length<Math.max(60,slowPeriod+atrPeriod+2)||payload.candles.length>5000)
    throw new Error("candles must contain sufficient OHLC history for EMA and ATR evaluation (60 to 5000 records)");
  const candles=payload.candles.map(c=>{
    const row={timestamp:Date.parse(c?.timestamp),open:Number(c?.open),high:Number(c?.high),low:Number(c?.low),close:Number(c?.close)};
    if(!Number.isFinite(row.timestamp)||![row.open,row.high,row.low,row.close].every(Number.isFinite)||
       row.open<=0||row.high<=0||row.low<=0||row.close<=0||
       Math.max(row.open,row.high,row.low,row.close)>1e15||
       row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high))
      throw new Error("Each candle must contain a valid timestamp and consistent positive OHLC values");
    return {...row,iso:new Date(row.timestamp).toISOString()};
  });
  if(candles.some((v,i)=>i>0&&v.timestamp<=candles[i-1].timestamp))
    throw new Error("Candle timestamps must be valid, unique, and strictly increasing in input order");
  const continuity=inspectCandleContinuity(candles,payload.timeframe_minutes);
  if(continuity.status!=="CLEAN") throw new Error("ATR backtest candle history is "+continuity.status.toLowerCase()+"; missing intervals are not bridged");
  const starting=Number(payload.starting_capital??10000),fee=Number(payload.fee_bps??10);
  const slippage=Number(payload.slippage_bps??5),spread=Number(payload.spread_bps??0);
  if(!Number.isFinite(starting)||starting<=0||!Number.isFinite(fee)||fee<0||fee>500||
     !Number.isFinite(slippage)||slippage<0||slippage>500||!Number.isFinite(spread)||spread<0||spread>500)
    throw new Error("Invalid starting capital or transaction costs; fee/slippage/spread must be between 0 and 500 bps");
  const evaluationStart=Number(payload.evaluation_start_index??0);
  if(!Number.isInteger(evaluationStart)||evaluationStart<0||evaluationStart>candles.length-2||
     (evaluationStart>0&&evaluationStart<Math.max(slowPeriod+1,atrPeriod+1)))
    throw new Error("evaluation_start_index must be zero or at least max(slow_period + 1, atr_period + 1) and leave an evaluation candle");
  const cost=(fee+slippage+spread/2)/10000;
  const closes=candles.map(x=>x.close),fast=ema(closes,fastPeriod),slow=ema(closes,slowPeriod);
  const fastAligned=fast.slice(slowPeriod-fastPeriod);
  const trueRanges=candles.map((c,i)=>i===0?c.high-c.low:
    Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
  const atrs=new Array(candles.length).fill(null);
  if(candles.length>atrPeriod){
    let atr=trueRanges.slice(1,atrPeriod+1).reduce((a,b)=>a+b,0)/atrPeriod;
    atrs[atrPeriod]=atr;
    for(let i=atrPeriod+1;i<candles.length;i++){
      atr=(atr*(atrPeriod-1)+trueRanges[i])/atrPeriod;
      atrs[i]=atr;
    }
  }
  let cash=starting,position=null;
  const trades=[],equityCurve=[{timestamp:candles[Math.max(0,evaluationStart-1)].iso,equity:round2(starting)}];
  const drawdownCurve=[{timestamp:candles[Math.max(0,evaluationStart-1)].iso,equity:starting}];
  const closePosition=(index,rawExit,reason)=>{
    const exitPrice=rawExit*(1-cost),proceeds=position.quantity*exitPrice;
    const pnl=proceeds-position.quantity*position.entry_price;
    if(!Number.isFinite(exitPrice)||exitPrice<=0||!Number.isFinite(proceeds)||!Number.isFinite(pnl))
      throw new Error("ATR backtest settlement is outside the supported numeric range");
    cash+=proceeds;
    trades.push({entry_time:position.entry_time,exit_time:candles[index].iso,
      entry_price:round6(position.entry_price),exit_price:round6(exitPrice),
      stop_price:round6(position.stop),target_price:round6(position.target),
      quantity:Number(position.quantity.toFixed(8)),pnl:round2(pnl),
      return_pct:round4(pnl/(position.quantity*position.entry_price)*100),
      initial_risk_amount:round2(position.risk_amount),exit_reason:reason});
    position=null;
  };
  for(let i=Math.max(1,evaluationStart);i<candles.length;i++){
    const candle=candles[i],signalIndex=i-1,alignedIndex=i-slowPeriod;
    const signalReady=alignedIndex>=1&&alignedIndex<slow.length&&Number.isFinite(atrs[signalIndex])&&atrs[signalIndex]>0;
    const previousUp=signalReady&&fastAligned[alignedIndex-1]>slow[alignedIndex-1];
    const currentUp=signalReady&&fastAligned[alignedIndex]>slow[alignedIndex];
    const bullish=signalReady&&!previousUp&&currentUp;
    const bearish=signalReady&&previousUp&&!currentUp;
    if(position){
      const stopHit=candle.low<=position.stop,targetHit=candle.high>=position.target;
      if(stopHit&&targetHit){
        // Conservative assumption when intrabar ordering is unknowable.
        const rawExit=candle.open<=position.stop?candle.open:position.stop;
        closePosition(i,rawExit,"STOP_LOSS_BOTH_LEVELS_TOUCHED");
      } else if(stopHit){
        closePosition(i,candle.open<=position.stop?candle.open:position.stop,
          candle.open<=position.stop?"STOP_LOSS_GAP":"STOP_LOSS");
      } else if(targetHit){
        closePosition(i,candle.open>=position.target?candle.open:position.target,
          candle.open>=position.target?"TAKE_PROFIT_GAP":"TAKE_PROFIT");
      } else if(bearish){
        closePosition(i,candle.open,"EMA_BEARISH_CROSS");
      }
    }
    if(!position&&bullish){
      const entryPrice=candle.open*(1+cost),atr=atrs[signalIndex];
      const stop=entryPrice-atr*stopMultiple,target=entryPrice+atr*stopMultiple*rewardMultiple;
      const riskPerUnit=entryPrice-stop*(1-cost);
      const riskBudget=cash*riskFraction;
      const riskQuantity=riskBudget/riskPerUnit;
      const cashQuantity=cash/entryPrice;
      const quantity=Math.min(riskQuantity,cashQuantity);
      if([entryPrice,stop,target,riskPerUnit,riskBudget,quantity].every(Number.isFinite)&&
         entryPrice>0&&stop>0&&target>entryPrice&&riskPerUnit>0&&quantity>0){
        const invested=quantity*entryPrice;
        if(Number.isFinite(invested)&&invested<=cash*(1+1e-10)){
          cash=Math.max(0,cash-invested);
          position={entry_price:entryPrice,entry_time:candle.iso,quantity,stop,target,
            risk_amount:quantity*riskPerUnit};
        }
      }
    }
    const equity=cash+(position?position.quantity*candle.close*(1-cost):0);
    if(!Number.isFinite(equity)||equity<=0) throw new Error("ATR backtest equity is outside the supported numeric range");
    equityCurve.push({timestamp:candle.iso,equity:round2(equity)});
    const adverseEquity=cash+(position?position.quantity*candle.low*(1-cost):0);
    if(!Number.isFinite(adverseEquity)||adverseEquity<=0) throw new Error("ATR backtest adverse equity is outside the supported numeric range");
    drawdownCurve.push({timestamp:candle.iso,equity:adverseEquity});
  }
  const lastIndex=candles.length-1;
  if(position) closePosition(lastIndex,candles[lastIndex].close,"END_OF_TEST");
  const finalEquity=cash;
  let peak=starting,maxDrawdown=0;
  for(let i=0;i<equityCurve.length;i++){
    peak=Math.max(peak,equityCurve[i].equity);
    const adverse=drawdownCurve[i]?.equity??equityCurve[i].equity;
    if(peak>0) maxDrawdown=Math.max(maxDrawdown,(peak-adverse)/peak);
  }
  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0);
  const grossProfit=wins.reduce((s,t)=>s+t.pnl,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  let lossStreak=0,longestLossStreak=0,lossRun=0,worstLossRun=0;
  for(const trade of trades){
    if(trade.pnl<0){lossStreak++;longestLossStreak=Math.max(longestLossStreak,lossStreak);lossRun+=trade.pnl;worstLossRun=Math.min(worstLossRun,lossRun);}
    else {lossStreak=0;lossRun=0;}
  }
  return {strategy:"EMA crossover with ATR stop and fixed fractional risk",
    fast_period:fastPeriod,slow_period:slowPeriod,atr_period:atrPeriod,evaluation_start_index:evaluationStart,
    evaluation_start_at:evaluationStart>0?candles[evaluationStart].iso:null,
    atr_stop_multiple:stopMultiple,reward_risk_ratio:rewardMultiple,risk_fraction:riskFraction,
    starting_capital:round2(starting),final_equity:round2(finalEquity),
    net_return_pct:round4((finalEquity/starting-1)*100),max_drawdown_pct:round4(maxDrawdown*100),
    drawdown_method:"Running peak of close-marked equity versus intrabar low for open long positions, including estimated exit costs.",
    closed_trades:trades.length,win_rate_pct:trades.length?round2(wins.length/trades.length*100):0,
    profit_factor:grossLoss>0?round4(grossProfit/grossLoss):grossProfit>0?"infinity":null,
    loss_streak_diagnostics:{longest_consecutive_losses:longestLossStreak,current_consecutive_losses:lossStreak,
      worst_consecutive_loss_run_pnl:round2(worstLossRun)},
    risk_model:{method:"fixed_fractional",risk_fraction:riskFraction,
      max_risk_per_trade_pct:round2(riskFraction*100),position_sizing:"risk budget divided by entry-to-stop loss including estimated exit costs, capped by available cash; no leverage",
      stop:"entry price minus ATR times stop multiple",target:"entry price plus ATR stop distance times reward/risk ratio"},
    cost_model:{fee_bps_per_side:fee,slippage_bps_per_side:slippage,spread_bps_full:spread,
      estimated_cost_bps_per_side:round2(fee+slippage+spread/2)},
    trades,equity_curve:equityCurve,open_position:false,
    warning:"Research only. ATR stop/risk sizing is a separate long-only model; same-candle stop/target collisions assume stop first. No leverage or broker execution. Actual fills, taxes, liquidity and market impact may differ; results do not predict future performance."};
}


function runStrategyComparison(payload) {
  if(!payload||!Array.isArray(payload.candles)) throw new Error("candles are required for a same-sample strategy comparison");
  const common={
    candles:payload.candles,
    timeframe_minutes:payload.timeframe_minutes,
    starting_capital:payload.starting_capital??10000,
    fee_bps:payload.fee_bps??10,
    slippage_bps:payload.slippage_bps??5,
    spread_bps:payload.spread_bps??0
  };
  const fast=payload.fast_period??20,slow=payload.slow_period??50;
  const emaResult=runBacktest({...common,fast_period:fast,slow_period:slow});
  const atrResult=runAtrRiskBacktest({...common,fast_period:fast,slow_period:slow,
    atr_period:payload.atr_period??14,atr_stop_multiple:payload.atr_stop_multiple??2,
    reward_risk_multiple:payload.reward_risk_multiple??1.5,risk_fraction:payload.risk_fraction??0.01});
  const metrics=result=>({
    starting_capital:result.starting_capital,final_equity:result.final_equity,
    net_return_pct:result.net_return_pct,max_drawdown_pct:result.max_drawdown_pct,
    closed_trades:result.closed_trades,win_rate_pct:result.win_rate_pct,
    profit_factor:result.profit_factor
  });
  const emaMetrics=metrics(emaResult),atrMetrics=metrics(atrResult);
  return {
    status:"COMPLETED",same_sample:true,candle_count:payload.candles.length,
    first_candle_at:payload.candles[0]?.timestamp??null,
    last_candle_at:payload.candles[payload.candles.length-1]?.timestamp??null,
    timeframe_minutes:payload.timeframe_minutes??null,
    assumptions:{starting_capital:common.starting_capital,fee_bps_per_side:common.fee_bps,
      slippage_bps_per_side:common.slippage_bps,spread_bps_full:common.spread_bps,
      ema_fast_period:fast,ema_slow_period:slow,atr_period:atrResult.atr_period,
      atr_stop_multiple:atrResult.atr_stop_multiple,reward_risk_ratio:atrResult.reward_risk_ratio,
      atr_risk_fraction:atrResult.risk_fraction},
    models:{
      ema_crossover:{strategy:emaResult.strategy,metrics:emaMetrics,
        sizing:"Existing EMA baseline sizing; no stop-loss overlay."},
      atr_fixed_risk:{strategy:atrResult.strategy,metrics:atrMetrics,
        sizing:atrResult.risk_model.position_sizing,
        loss_streak_diagnostics:atrResult.loss_streak_diagnostics}
    },
    difference_atr_minus_ema:{
      net_return_pct:round4(atrMetrics.net_return_pct-emaMetrics.net_return_pct),
      max_drawdown_pct:round4(atrMetrics.max_drawdown_pct-emaMetrics.max_drawdown_pct),
      final_equity:round2(atrMetrics.final_equity-emaMetrics.final_equity),
      closed_trades:atrMetrics.closed_trades-emaMetrics.closed_trades
    },
    interpretation_note:"Same candles, timeframe, starting capital and transaction-cost assumptions. The two sizing/exit models differ, so compare net return together with drawdown and sample size; no single metric establishes superiority. Results are historical simulations, not forecasts.",
    execution_enabled:false
  };
}

function runOutOfSampleStrategyComparison(payload) {
  if(!payload||!Array.isArray(payload.candles)||payload.candles.length<240||payload.candles.length>5000)
    throw new Error("Out-of-sample comparison requires 240 to 5000 OHLC candles");
  const candles=payload.candles;
  const timestamps=candles.map(c=>Date.parse(c?.timestamp));
  if(timestamps.some((t,i)=>!Number.isFinite(t)||(i>0&&t<=timestamps[i-1])))
    throw new Error("Out-of-sample candles must be valid, unique, and strictly increasing");
  const continuity=inspectCandleContinuity(candles,payload.timeframe_minutes);
  if(continuity.status!=="CLEAN")
    throw new Error("Out-of-sample history is "+continuity.status.toLowerCase()+"; missing or irregular intervals are not bridged");
  const splitIndex=Math.floor(candles.length*0.70);
  const common={candles,timeframe_minutes:payload.timeframe_minutes,
    starting_capital:payload.starting_capital??10000,fee_bps:payload.fee_bps??10,
    slippage_bps:payload.slippage_bps??5,spread_bps:payload.spread_bps??0};
  const fast=payload.fast_period??20,slow=payload.slow_period??50;
  const emaResult=runBacktest({...common,fast_period:fast,slow_period:slow,evaluation_start_index:splitIndex});
  const atrResult=runAtrRiskBacktest({...common,fast_period:fast,slow_period:slow,
    atr_period:payload.atr_period??14,atr_stop_multiple:payload.atr_stop_multiple??2,
    reward_risk_multiple:payload.reward_risk_multiple??1.5,risk_fraction:payload.risk_fraction??0.01,
    evaluation_start_index:splitIndex});
  const regimeSeries=precomputeWalkForwardRegimes(candles);
  const emaRegimes=buildWalkForwardRegimeDiagnostics(candles,splitIndex,candles.length,
    emaResult.equity_curve,emaResult.trades,regimeSeries);
  const atrRegimes=buildWalkForwardRegimeDiagnostics(candles,splitIndex,candles.length,
    atrResult.equity_curve,atrResult.trades,regimeSeries);
  const metrics=result=>({starting_capital:result.starting_capital,final_equity:result.final_equity,
    net_return_pct:result.net_return_pct,max_drawdown_pct:result.max_drawdown_pct,
    closed_trades:result.closed_trades,win_rate_pct:result.win_rate_pct,profit_factor:result.profit_factor,
    sample_status:result.closed_trades>=10?"DESCRIPTIVE_SAMPLE":"INSUFFICIENT_SAMPLE"});
  const emaMetrics=metrics(emaResult),atrMetrics=metrics(atrResult);
  return {status:"COMPLETED",evaluation:"CHRONOLOGICAL_HOLDOUT",same_out_of_sample_window:true,
    training_candles:splitIndex,test_candles:candles.length-splitIndex,
    training_start:candles[0].timestamp,training_end:candles[splitIndex-1].timestamp,
    out_of_sample_start:candles[splitIndex].timestamp,out_of_sample_end:candles[candles.length-1].timestamp,
    timeframe_minutes:payload.timeframe_minutes??null,
    assumptions:{starting_capital:common.starting_capital,fee_bps_per_side:common.fee_bps,
      slippage_bps_per_side:common.slippage_bps,spread_bps_full:common.spread_bps,
      parameters_fixed_before_test:true,ema_fast_period:fast,ema_slow_period:slow,
      atr_period:atrResult.atr_period,atr_stop_multiple:atrResult.atr_stop_multiple,
      reward_risk_ratio:atrResult.reward_risk_ratio,atr_risk_fraction:atrResult.risk_fraction},
    models:{ema_crossover:{metrics:emaMetrics,regime_diagnostics:emaRegimes},
      atr_fixed_risk:{metrics:atrMetrics,regime_diagnostics:atrRegimes}},
    difference_atr_minus_ema:{net_return_pct:round4(atrMetrics.net_return_pct-emaMetrics.net_return_pct),
      max_drawdown_pct:round4(atrMetrics.max_drawdown_pct-emaMetrics.max_drawdown_pct),
      final_equity:round2(atrMetrics.final_equity-emaMetrics.final_equity),
      closed_trades:atrMetrics.closed_trades-emaMetrics.closed_trades},
    sample_warning:"Fewer than 10 out-of-sample closed trades is INSUFFICIENT_SAMPLE. Regime buckets are descriptive only; small buckets are not evidence of an edge.",
    methodology_note:"Chronological 70/30 holdout. The first 70% is indicator warm-up only; no positions or P&L from training are included. Strategy parameters are fixed before the holdout and not optimized on its results. Regime labels for each test-bar fill use only candles completed before that bar. Results are historical simulations, not forecasts.",
    execution_enabled:false};
}

function precomputeWalkForwardRegimes(candles) {
  const closes=candles.map(c=>Number(c.close));
  const fast=ema(closes,20),slow=ema(closes,50);
  const trueRangePrefix=new Array(candles.length+1).fill(0);
  for(let i=1;i<candles.length;i++){
    const previous=closes[i-1],candle=candles[i];
    const trueRange=Math.max(Number(candle.high)-Number(candle.low),
      Math.abs(Number(candle.high)-previous),Math.abs(Number(candle.low)-previous));
    trueRangePrefix[i+1]=trueRangePrefix[i]+trueRange;
  }
  const regimes=new Array(candles.length);
  for(let openIndex=0;openIndex<candles.length;openIndex++){
    const end=openIndex-1;
    if(end<59){regimes[openIndex]={status:"INSUFFICIENT_DATA"};continue;}
    const lastClose=closes[end];
    const atr=(trueRangePrefix[end+1]-trueRangePrefix[end-14])/15;
    const atrPct=atr/lastClose*100;
    const spreadPct=Math.abs(fast[end]-slow[end])/lastClose*100;
    const slopePct=(fast[end]-fast[end-1])/lastClose*100;
    const trend=fast[end]>slow[end]?"BULLISH":fast[end]<slow[end]?"BEARISH":"NEUTRAL";
    let status="TRANSITIONAL";
    if(![atrPct,spreadPct,slopePct].every(Number.isFinite)||atrPct<=0) status="UNAVAILABLE";
    else if(atrPct>1.5) status="HIGH_VOLATILITY";
    else if(spreadPct<0.04&&Math.abs(slopePct)<0.0015) status="RANGE";
    else if(spreadPct>=0.04&&((trend==="BULLISH"&&slopePct>0)||(trend==="BEARISH"&&slopePct<0))) status="TRENDING";
    regimes[openIndex]={status,atr_pct:atrPct,ema_spread_pct:spreadPct,ema20_slope_pct:slopePct};
  }
  return regimes;
}

function buildWalkForwardRegimeDiagnostics(candles,testStart,testEnd,equityCurve,trades,regimeSeries) {
  const groups=new Map(),regimeByEntryTime=new Map();
  const ensure=regime=>{
    if(!groups.has(regime)) groups.set(regime,{regime,bars:0,equity_change_attribution:0,
      trade_count:0,winning_trades:0,net_trade_pnl:0,trade_return_sum:0,
      atr_pct_sum:0,ema_spread_pct_sum:0,ema20_slope_pct_sum:0,indicator_count:0});
    return groups.get(regime);
  };
  let firstBarRegime=null,lastBarRegime=null;
  for(let index=testStart;index<testEnd;index++){
    // The label for a fill at this candle's open uses only the preceding
    // completed candle history. The current candle is deliberately excluded.
    const snapshot=regimeSeries[index]||{status:"UNAVAILABLE"};
    const regime=snapshot.status||"UNAVAILABLE";
    const timestamp=new Date(Date.parse(candles[index].timestamp)).toISOString();
    regimeByEntryTime.set(timestamp,regime);
    if(firstBarRegime===null) firstBarRegime=regime;
    lastBarRegime=regime;
    const group=ensure(regime);
    group.bars++;
    const before=equityCurve[index-testStart]?.equity;
    const after=equityCurve[index-testStart+1]?.equity;
    if(Number.isFinite(before)&&Number.isFinite(after)) group.equity_change_attribution+=after-before;
    if([snapshot.atr_pct,snapshot.ema_spread_pct,snapshot.ema20_slope_pct].every(Number.isFinite)){
      group.atr_pct_sum+=snapshot.atr_pct;
      group.ema_spread_pct_sum+=snapshot.ema_spread_pct;
      group.ema20_slope_pct_sum+=snapshot.ema20_slope_pct;
      group.indicator_count++;
    }
  }
  for(const trade of trades){
    const regime=regimeByEntryTime.get(trade.entry_time)||"UNAVAILABLE";
    const group=ensure(regime);
    group.trade_count++;
    if(Number(trade.pnl)>0) group.winning_trades++;
    group.net_trade_pnl+=Number(trade.pnl)||0;
    group.trade_return_sum+=Number(trade.return_pct)||0;
  }
  const buckets=[...groups.values()].map(group=>({
    regime:group.regime,bars:group.bars,
    bar_share_pct:round2((group.bars/(testEnd-testStart))*100),
    average_atr_pct:group.indicator_count?round4(group.atr_pct_sum/group.indicator_count):null,
    average_ema_spread_pct:group.indicator_count?round4(group.ema_spread_pct_sum/group.indicator_count):null,
    average_ema20_slope_pct:group.indicator_count?round4(group.ema20_slope_pct_sum/group.indicator_count):null,
    equity_change_attribution:round2(group.equity_change_attribution),
    trade_count:group.trade_count,winning_trades:group.winning_trades,
    win_rate_pct:group.trade_count?round2(group.winning_trades/group.trade_count*100):0,
    net_trade_pnl:round2(group.net_trade_pnl),
    average_trade_return_pct:group.trade_count?round4(group.trade_return_sum/group.trade_count):null
  })).sort((a,b)=>b.bars-a.bars||a.regime.localeCompare(b.regime));
  return {first_bar_regime:firstBarRegime,last_bar_regime:lastBarRegime,buckets};
}

function runWalkForward(payload) {
  if(!payload||!Array.isArray(payload.candles)||payload.candles.length<180||payload.candles.length>5000)
    throw new Error("Walk-forward evaluation requires 180 to 5000 OHLC candles");
  const candles=[...payload.candles];
  const timestamps=candles.map(c=>Date.parse(c?.timestamp));
  if(timestamps.some((t,i)=>!Number.isFinite(t)||(i>0&&t<=timestamps[i-1])))
    throw new Error("Walk-forward candle timestamps must be valid, unique, and strictly increasing in input order");
  const continuity=inspectCandleContinuity(candles,payload.timeframe_minutes);
  if(continuity.status!=="CLEAN")
    throw new Error("Walk-forward candle history is "+continuity.status.toLowerCase()+"; missing or irregular intervals are not bridged");
  const candidates=[[9,21],[12,26],[20,50]];
  const starting=Number(payload.starting_capital??10000);
  const fee=Number(payload.fee_bps??10),slippage=Number(payload.slippage_bps??5),spread=Number(payload.spread_bps??0);
  if(!Number.isFinite(starting)||starting<=0||!Number.isFinite(fee)||fee<0||fee>500||
     !Number.isFinite(slippage)||slippage<0||slippage>500||!Number.isFinite(spread)||spread>500||spread<0)
    throw new Error("Invalid starting capital or transaction costs; fee/slippage/spread must be between 0 and 500 bps");
  const n=candles.length;
  const boundaries=[Math.floor(n*0.55),Math.floor(n*0.70),Math.floor(n*0.85)];
  let compounded=1,stressedCompounded=1,totalTrades=0,weightedWins=0,maxDrawdown=0;
  const stressCosts={fee_bps:Math.min(500,fee*2),slippage_bps:Math.min(500,slippage*2),spread_bps:Math.min(500,spread*2)};
  const regimeSeries=precomputeWalkForwardRegimes(candles);
  const folds=[];
  for(let i=0;i<boundaries.length;i++){
    const trainEnd=boundaries[i],testEnd=i+1<boundaries.length?boundaries[i+1]:n;
    let best=null;
    for(const [fast,slow] of candidates){
      const train=runBacktest({candles:candles.slice(0,trainEnd),fast_period:fast,slow_period:slow,
        starting_capital:starting,fee_bps:fee,slippage_bps:slippage,spread_bps:spread});
      const score=train.net_return_pct-0.5*train.max_drawdown_pct;
      if(!best||score>best.selection_score)
        best={fast_period:fast,slow_period:slow,selection_score:round4(score),
          training_return_pct:train.net_return_pct,training_drawdown_pct:train.max_drawdown_pct};
    }
    const test=runBacktest({candles:candles.slice(0,testEnd),fast_period:best.fast_period,
      slow_period:best.slow_period,starting_capital:starting,fee_bps:fee,slippage_bps:slippage,spread_bps:spread,
      evaluation_start_index:trainEnd});
    // Re-evaluate the exact same training-selected parameters and OOS window
    // under doubled transaction costs. No parameter reselection is performed.
    const stressedTest=runBacktest({candles:candles.slice(0,testEnd),fast_period:best.fast_period,
      slow_period:best.slow_period,starting_capital:starting,...stressCosts,evaluation_start_index:trainEnd});
    compounded*=test.final_equity/starting;
    stressedCompounded*=stressedTest.final_equity/starting;
    const regimeDiagnostics=buildWalkForwardRegimeDiagnostics(
      candles,trainEnd,testEnd,test.equity_curve,test.trades,regimeSeries);
    totalTrades+=test.closed_trades;
    weightedWins+=test.closed_trades*test.win_rate_pct/100;
    maxDrawdown=Math.max(maxDrawdown,test.max_drawdown_pct);
    folds.push({fold:i+1,training_start:candles[0].timestamp,training_end:candles[trainEnd-1].timestamp,
      test_start:candles[trainEnd].timestamp,test_end:candles[testEnd-1].timestamp,
      selected_strategy:`EMA${best.fast_period}/EMA${best.slow_period}`,
      selected_parameters:{fast_period:best.fast_period,slow_period:best.slow_period},
      training_selection_score:best.selection_score,training_return_pct:best.training_return_pct,
      training_drawdown_pct:best.training_drawdown_pct,
      out_of_sample_return_pct:test.net_return_pct,
      stressed_out_of_sample_return_pct:stressedTest.net_return_pct,
      stress_return_delta_pct:round4(stressedTest.net_return_pct-test.net_return_pct),
      evaluation_window_start_at:test.evaluation_start_at,
      first_test_fill_at:test.trades[0]?.entry_time??null,
      first_test_fill_on_window_open:(test.trades[0]?.entry_time??null)===test.evaluation_start_at,
      test_window_start_open_included:true,
      out_of_sample_drawdown_pct:test.max_drawdown_pct,
      stressed_out_of_sample_drawdown_pct:stressedTest.max_drawdown_pct,
      out_of_sample_trades:test.closed_trades,out_of_sample_win_rate_pct:test.win_rate_pct,
      out_of_sample_profit_factor:test.profit_factor,
      regime_diagnostics:regimeDiagnostics});
  }
  const regimeTotals=new Map();
  for(const fold of folds) for(const bucket of fold.regime_diagnostics.buckets){
    if(!regimeTotals.has(bucket.regime)) regimeTotals.set(bucket.regime,{
      regime:bucket.regime,bars:0,equity_change_attribution:0,trade_count:0,
      winning_trades:0,net_trade_pnl:0,trade_return_sum:0,
      atr_weighted_sum:0,ema_spread_weighted_sum:0,slope_weighted_sum:0,indicator_bars:0});
    const total=regimeTotals.get(bucket.regime);
    total.bars+=bucket.bars;
    total.equity_change_attribution+=bucket.equity_change_attribution;
    total.trade_count+=bucket.trade_count;
    total.winning_trades+=bucket.winning_trades;
    total.net_trade_pnl+=bucket.net_trade_pnl;
    total.trade_return_sum+=(bucket.average_trade_return_pct??0)*bucket.trade_count;
    if(Number.isFinite(bucket.average_atr_pct)&&Number.isFinite(bucket.average_ema_spread_pct)&&
       Number.isFinite(bucket.average_ema20_slope_pct)){
      total.atr_weighted_sum+=bucket.average_atr_pct*bucket.bars;
      total.ema_spread_weighted_sum+=bucket.average_ema_spread_pct*bucket.bars;
      total.slope_weighted_sum+=bucket.average_ema20_slope_pct*bucket.bars;
      total.indicator_bars+=bucket.bars;
    }
  }
  const regimeBuckets=[...regimeTotals.values()].map(group=>({
    regime:group.regime,bars:group.bars,
    bar_share_pct:round2(group.bars/(n-boundaries[0])*100),
    average_atr_pct:group.indicator_bars?round4(group.atr_weighted_sum/group.indicator_bars):null,
    average_ema_spread_pct:group.indicator_bars?round4(group.ema_spread_weighted_sum/group.indicator_bars):null,
    average_ema20_slope_pct:group.indicator_bars?round4(group.slope_weighted_sum/group.indicator_bars):null,
    equity_change_attribution:round2(group.equity_change_attribution),
    trade_count:group.trade_count,winning_trades:group.winning_trades,
    win_rate_pct:group.trade_count?round2(group.winning_trades/group.trade_count*100):0,
    net_trade_pnl:round2(group.net_trade_pnl),
    average_trade_return_pct:group.trade_count?round4(group.trade_return_sum/group.trade_count):null
  })).sort((a,b)=>b.bars-a.bars||a.regime.localeCompare(b.regime));
  const foldReturns=folds.map(f=>f.out_of_sample_return_pct);
  const positiveFolds=foldReturns.filter(v=>v>0).length;
  const negativeFolds=foldReturns.filter(v=>v<0).length;
  const sortedReturns=[...foldReturns].sort((a,b)=>a-b);
  const medianReturn=sortedReturns.length%2?sortedReturns[(sortedReturns.length-1)/2]:(sortedReturns[sortedReturns.length/2-1]+sortedReturns[sortedReturns.length/2])/2;
  const minFoldTrades=Math.min(...folds.map(f=>f.out_of_sample_trades));
  const sampleSufficient=totalTrades>=20&&minFoldTrades>=5;
  const stabilityStatus=!sampleSufficient?"INSUFFICIENT_SAMPLE":positiveFolds===folds.length?"CONSISTENT_POSITIVE":negativeFolds===folds.length?"CONSISTENT_NEGATIVE":"MIXED";
  return {method:"expanding-window walk-forward; each fold selects among EMA 9/21, 12/26, 20/50 using past data only",
    stability:{status:stabilityStatus,sample_sufficient:sampleSufficient,positive_folds:positiveFolds,negative_folds:negativeFolds,
      positive_fold_ratio_pct:round2(positiveFolds/folds.length*100),median_fold_return_pct:round4(medianReturn),
      fold_return_range_pct:round4(Math.max(...foldReturns)-Math.min(...foldReturns)),min_fold_trades:minFoldTrades,
      minimum_total_trades_required:20,minimum_trades_per_fold_required:5,
      note:"Consistency is descriptive, not statistical proof or a profitability guarantee."},
    timeframe_minutes:continuity.timeframe_minutes,timeframe_inferred:continuity.timeframe_inferred,
    data_quality:{status:continuity.status,gap_count:continuity.gap_count,
      misaligned_interval_count:continuity.misaligned_interval_count},
    regime_diagnostics:{method:"retrospective bar and trade attribution using classifyMarketRegime on candles completed before each test candle opens",
      lookahead_used:false,buckets:regimeBuckets,
      note:"Regime labels are descriptive diagnostics, not predictive signals. Equity change is attributed to the regime known before each bar; trades are grouped by regime at entry."},
    folds,fold_count:folds.length,starting_capital:round2(starting),
    compounded_out_of_sample_return_pct:round4((compounded-1)*100),
    stress_test:{method:"same out-of-sample folds and training-selected parameters; transaction costs doubled; no reselection",
      cost_multiplier:2,cost_model:{fee_bps_per_side:stressCosts.fee_bps,
        slippage_bps_per_side:stressCosts.slippage_bps,spread_bps_full:stressCosts.spread_bps,
        spread_bps_per_side:stressCosts.spread_bps/2},
      compounded_out_of_sample_return_pct:round4((stressedCompounded-1)*100),
      return_delta_vs_baseline_pct:round4((stressedCompounded-compounded)*100),
      folds_with_lower_return:folds.filter(f=>f.stress_return_delta_pct<0).length},
    worst_fold_drawdown_pct:round4(maxDrawdown),total_out_of_sample_trades:totalTrades,
    aggregate_out_of_sample_win_rate_pct:totalTrades?round2(weightedWins/totalTrades*100):0,
    cost_model:{fee_bps_per_side:fee,slippage_bps_per_side:slippage,spread_bps_full:spread,spread_bps_per_side:spread/2},
    execution_enabled:false,
    warning:"Research only. Parameters are selected on each training window and evaluated only on the following unseen window. The doubled-cost stress case is a sensitivity scenario, not a forecast of actual broker costs. Small samples, provider quality, spread changes, market impact and broker execution can materially change results; this is not a prediction or trading recommendation."};
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
  const intervalMs=timeframe*60*1000;
  const gaps=[];
  const irregularIntervals=[];
  for(let i=1;i<candles.length;i++){
    const delta=candles[i].timestamp-candles[i-1].timestamp;
    const intervalCount=Math.round(delta/intervalMs);
    const alignmentErrorMs=Math.abs(delta-intervalCount*intervalMs);
    if(intervalCount<1||alignmentErrorMs>Math.max(1000,intervalMs*0.01)){
      irregularIntervals.push({from:candles[i-1].iso,to:candles[i].iso,
        delta_seconds:Math.round(delta/1000),expected_interval_minutes:timeframe});
      continue;
    }
    if(intervalCount>1){
      gaps.push({from:candles[i-1].iso,to:candles[i].iso,
        missing_intervals:intervalCount-1});
    }
  }
  if(irregularIntervals.length){
    return {signal:"NO_TRADE",confidence:0,
      reason:"Candle timestamps do not follow the declared timeframe; irregular intervals are blocked.",
      data_status:"MISALIGNED",irregular_interval_count:irregularIntervals.length,
      irregular_intervals:irregularIntervals.slice(0,20),last_candle_at:last.iso,
      age_seconds:Math.round(ageSeconds),timeframe_minutes:timeframe,execution_enabled:false};
  }
  if(gaps.length){
    return {signal:"NO_TRADE",confidence:0,reason:"Candle history contains missing intervals; signal generation is blocked until a continuous history is available.",
      data_status:"GAPPED",gap_count:gaps.length,
      missing_intervals:gaps.reduce((sum,g)=>sum+g.missing_intervals,0),
      largest_gap_intervals:gaps.reduce((max,g)=>Math.max(max,g.missing_intervals),0),
      gaps:gaps.slice(0,20),last_candle_at:last.iso,age_seconds:Math.round(ageSeconds),
      timeframe_minutes:timeframe,execution_enabled:false};
  }
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
  const proposedSide=longScore>=4&&longScore>shortScore?"BUY":shortScore>=4&&shortScore>longScore?"SELL":"NO_TRADE";
  const regime=classifyMarketRegime(candles);
  const regimeBlocked=proposedSide!=="NO_TRADE"&&!regime.tradeable;
  const side=regimeBlocked?"NO_TRADE":proposedSide;
  const score=proposedSide==="BUY"?longScore:proposedSide==="SELL"?shortScore:Math.max(longScore,shortScore);
  const confidence=side==="NO_TRADE"?0:score*20;
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
  reasons.push("Market regime: "+regime.status+" — "+regime.reason);
  if(regimeBlocked) reasons.push("Entry blocked by market-regime quality filter.");
  return {signal:side,proposed_signal:proposedSide,confidence,confluence_score:score*20,
    signal_quality:{status:side==="NO_TRADE"?"BLOCKED_OR_NO_SETUP":"TRADEABLE",regime_status:regime.status,
      regime_tradeable:regime.tradeable,blocked_by_regime:regimeBlocked,reason:regime.reason},
    market_regime:regime,confidence_type:"technical_confluence_score_not_probability",
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


function diagnoseCandleGaps(gaps) {
  const windows=new Map();
  const gapDetails=gaps.slice(0,50).map(gap=>{
    const from=Date.parse(gap.from),to=Date.parse(gap.to);
    const valid=Number.isFinite(from)&&Number.isFinite(to)&&to>from;
    return {
      from:gap.from,to:gap.to,
      missing_intervals:Number(gap.missing_intervals)||null,
      elapsed_minutes:valid?Math.round((to-from)/60000*100)/100:null,
      weekday_utc:valid?new Date(from).toLocaleDateString("en-US",{timeZone:"UTC",weekday:"short"}):null,
      classification:"UNCLASSIFIED"
    };
  });
  for(const gap of gaps){
    const from=Date.parse(gap.from),to=Date.parse(gap.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)) continue;
    const start=new Date(from).toISOString().slice(11,16);
    const end=new Date(to).toISOString().slice(11,16);
    const key=start+"-"+end;
    if(!windows.has(key)) windows.set(key,{start_time_utc:start,end_time_utc:end,
      occurrences:0,dates:[]});
    const item=windows.get(key);
    item.occurrences++;
    const date=new Date(from).toISOString().slice(0,10);
    if(!item.dates.includes(date)) item.dates.push(date);
  }
  const recurring=[...windows.values()].filter(item=>item.occurrences>=2);
  return {classification:"UNCLASSIFIED",gap_details:gapDetails,
    recurring_windows_utc:recurring,
    isolated_gap_count:gaps.filter(gap=>{
      const from=Date.parse(gap.from),to=Date.parse(gap.to);
      if(!Number.isFinite(from)||!Number.isFinite(to)) return true;
      const key=new Date(from).toISOString().slice(11,16)+"-"+new Date(to).toISOString().slice(11,16);
      return !recurring.some(item=>key===item.start_time_utc+"-"+item.end_time_utc);
    }).length,
    note:"A repeated timing pattern does not prove a market closure. Per-gap timing and duration are diagnostic only; no missing candle is filled, interpolated, or ignored."};
}

function classifyOhlcProviderFailure(reason) {
  const message=String(reason||"");
  if(/freshness metadata|data state is|data_state|as_of timestamp|age_seconds/i.test(message)) return "FRESHNESS_METADATA_INVALID";
  if(/stale/i.test(message)) return "SOURCE_STALE";
  if(/HTTP [0-9]{3}|fetch failed|network|timeout|provider unavailable/i.test(message)) return "PROVIDER_UNAVAILABLE";
  if(/malformed|duplicate candle|timestamp.*aligned|unexpected.*schema|no completed.*candles/i.test(message)) return "OHLC_INVALID_OR_MISSING";
  return "UNKNOWN_FAILURE";
}

const CANDLE_SYMBOLS = new Map([["xau", "xau"]]);
const CANDLE_INTERVALS = new Map([["15m", 900], ["30m", 1800], ["60m", 3600], ["1d", 86400]]);

async function fetchGoldCandlesFromXaus(symbol, interval) {
  const providerSymbol = CANDLE_SYMBOLS.get(symbol);
  const intervalSeconds = CANDLE_INTERVALS.get(interval);
  if (!providerSymbol || !intervalSeconds) throw new Error("Unsupported candle symbol or interval");
  // The 60m signal archive retains 90 days; fetch enough hourly history
  // to evaluate that same retention window instead of silently limiting stats to 5 days.
  const range = interval === "1d" || interval === "60m" ? "3mo" : "5d";
  const endpoint = "https://xaus.com/api/v1/chart?symbol=" +
    encodeURIComponent(providerSymbol) + "&range=" + range + "&interval=" + interval;
  const response = await fetch(endpoint, {
    headers: {accept:"application/json", "user-agent":"AyyarSmartTrader/1.0"},
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("XAUS OHLC provider HTTP " + response.status);
  const payload = await response.json();
  const state = payload?.data_state;
  if (!state || typeof state !== "object")
    throw new Error("XAUS OHLC provider data_state metadata is missing");
  if (state.status !== "fresh")
    throw new Error("XAUS OHLC provider data state is " + String(state.status || "missing"));
  if (typeof state.as_of !== "string" || !state.as_of.trim())
    throw new Error("XAUS OHLC provider data_state.as_of timestamp is missing");
  const stateStamp = parseStamp(state.as_of);
  if (!stateStamp)
    throw new Error("XAUS OHLC provider data_state.as_of timestamp is invalid");
  if (state.age_seconds === undefined || state.age_seconds === null || state.age_seconds === "")
    throw new Error("XAUS OHLC provider data_state.age_seconds is missing");
  const stateAge = Number(state.age_seconds);
  if (!Number.isFinite(stateAge) || stateAge < 0)
    throw new Error("XAUS OHLC provider data_state.age_seconds is invalid");
  if (stateAge > XAUS_MAX_AGE_SECONDS)
    throw new Error("XAUS OHLC provider data_state.age_seconds is stale");
  const timestampAge = (Date.now() - stateStamp.getTime()) / 1000;
  if (!Number.isFinite(timestampAge) || timestampAge < -30)
    throw new Error("XAUS OHLC provider data_state.as_of timestamp is in the future");
  if (timestampAge > XAUS_MAX_AGE_SECONDS)
    throw new Error("XAUS OHLC provider data_state.as_of timestamp is stale");
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
    if (time % intervalMs !== 0) {
      throw new Error("XAUS returned a candle timestamp that is not aligned to its declared interval; data quality check failed");
    }
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
  // Candle timestamps identify the candle OPEN. Measure freshness from close
  // time so the age has the same meaning for XAUS and BIQUOTE.
  const lastCandleCloseAt=Date.parse(last.timestamp)+intervalMs;
  const ageSeconds=(Date.now()-lastCandleCloseAt)/1000;
  const freshnessLimit=Math.max(600,intervalSeconds*2);
  if (ageSeconds < -30 || ageSeconds > freshnessLimit)
    throw new Error("Latest completed XAUS OHLC candle is stale (last_candle_close_at="+new Date(lastCandleCloseAt).toISOString()+", age_seconds="+Math.round(ageSeconds)+", freshness_limit_seconds="+freshnessLimit+")");
  const gaps=[];
  for(let i=1;i<candles.length;i++){
    const delta=(Date.parse(candles[i].timestamp)-Date.parse(candles[i-1].timestamp))/intervalMs;
    if(delta>1.01) gaps.push({from:candles[i-1].timestamp,to:candles[i].timestamp,missing_intervals:Math.max(1,Math.round(delta)-1)});
  }
  const dataQuality={status:gaps.length?"GAPS_DETECTED":"CLEAN",candle_count:candles.length,
    duplicate_count:0,rejected_completed_points:0,gap_count:gaps.length,
    missing_intervals:gaps.reduce((sum,g)=>sum+g.missing_intervals,0),
    largest_gap_intervals:gaps.reduce((max,g)=>Math.max(max,g.missing_intervals),0),
    gap_diagnostics:diagnoseCandleGaps(gaps),
    note:"Gaps are reported for transparency and may reflect market closures or provider omissions; they are not silently filled."};
  return {
    symbol, provider:"XAUS", provider_symbol:providerSymbol, source_url:"https://xaus.com/api/v1/chart",
    interval, interval_seconds:intervalSeconds, status:gaps.length?"PARTIAL":"LIVE",data_quality:dataQuality,
    analysis_ready:candles.length>=60,minimum_analysis_candles:60,
    retrieved_at:new Date().toISOString(), last_candle_at:last.timestamp,
    last_candle_close_at:new Date(lastCandleCloseAt).toISOString(),
    age_seconds:Math.max(0,Math.round(ageSeconds)), freshness_limit_seconds:freshnessLimit, candles,
    note:"Completed OHLC candles for global XAU/USD from XAUS chart API. Data is indicative, may be delayed, and is not a broker execution feed. Iranian gold and coin instruments are not represented by this feed."
  };
}

async function fetchGoldCandlesFromBiquote(symbol, interval) {
  const providerSymbol=symbol==="xau"?"XAUUSD":null;
  const intervalSeconds=CANDLE_INTERVALS.get(interval);
  const providerInterval=new Map([["15m","15m"],["30m","30m"],["60m","1h"],["1d","1d"]]).get(interval);
  if(!providerSymbol||!intervalSeconds||!providerInterval)
    throw new Error("Unsupported BIQUOTE symbol or interval");
  const endpoint="https://biquote.io/api/"+encodeURIComponent(providerSymbol)+
    "/ohlc?interval="+encodeURIComponent(providerInterval)+"&limit=250";
  const response=await fetch(endpoint,{
    headers:{accept:"application/json","user-agent":"AyyarSmartTrader/1.0"},
    signal:AbortSignal.timeout(10000)
  });
  if(!response.ok) throw new Error("BIQUOTE OHLC provider HTTP "+response.status);
  const payload=await response.json();
  if(String(payload?.symbol||"").toUpperCase()!=="XAUUSD"||payload?.interval!==providerInterval||
      !Array.isArray(payload?.bars))
    throw new Error("BIQUOTE returned an unexpected XAUUSD OHLC schema");
  const intervalMs=intervalSeconds*1000;
  const currentBucket=Math.floor(Date.now()/intervalMs)*intervalMs;
  const candles=[];
  let rejected=0;
  for(const bar of payload.bars){
    if(typeof bar?.isOpen!=="boolean") throw new Error("BIQUOTE candle is missing its closed/open state");
    if(bar.isOpen) continue;
    const time=Date.parse(bar?.openTime);
    if(!Number.isFinite(time)){rejected++;continue;}
    if(time>=currentBucket) continue;
    if(time%intervalMs!==0)
      throw new Error("BIQUOTE returned a candle timestamp that is not aligned to its declared interval");
    const open=Number(bar.open),high=Number(bar.high),low=Number(bar.low),close=Number(bar.close);
    if(![open,high,low,close].every(v=>Number.isFinite(v)&&v>0&&v<=1e15)||
        high<Math.max(open,close,low)||low>Math.min(open,close,high)){
      rejected++;
      continue;
    }
    candles.push({timestamp:new Date(time).toISOString(),open,high,low,close});
  }
  if(rejected) throw new Error("BIQUOTE returned "+rejected+" malformed completed OHLC bars");
  candles.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  if(candles.some((bar,i)=>i>0&&Date.parse(bar.timestamp)===Date.parse(candles[i-1].timestamp)))
    throw new Error("BIQUOTE returned duplicate candle timestamps");
  const last=candles[candles.length-1];
  if(!last) throw new Error("BIQUOTE returned no completed XAUUSD candles");
  const lastCloseTime=Date.parse(last.timestamp)+intervalMs;
  const ageSeconds=(Date.now()-lastCloseTime)/1000;
  const freshnessLimit=Math.max(600,intervalSeconds*2);
  if(ageSeconds < -30||ageSeconds>freshnessLimit)
    throw new Error("Latest completed BIQUOTE OHLC candle is stale (last_candle_close_at="+new Date(lastCloseTime).toISOString()+", age_seconds="+Math.round(ageSeconds)+", freshness_limit_seconds="+freshnessLimit+")");
  const gaps=[];
  for(let i=1;i<candles.length;i++){
    const delta=(Date.parse(candles[i].timestamp)-Date.parse(candles[i-1].timestamp))/intervalMs;
    if(delta>1.01) gaps.push({from:candles[i-1].timestamp,to:candles[i].timestamp,
      missing_intervals:Math.max(1,Math.round(delta)-1)});
  }
  const dataQuality={status:gaps.length?"GAPS_DETECTED":"CLEAN",candle_count:candles.length,
    duplicate_count:0,rejected_completed_points:0,gap_count:gaps.length,
    missing_intervals:gaps.reduce((sum,g)=>sum+g.missing_intervals,0),
    largest_gap_intervals:gaps.reduce((max,g)=>Math.max(max,g.missing_intervals),0),
    gaps:gaps.slice(0,50),gap_diagnostics:diagnoseCandleGaps(gaps),
    note:"BIQUOTE gaps are reported with timestamps, never filled or interpolated. Market closures and provider omissions remain visible to downstream quality gates."};
  return {
    symbol,provider:"BIQUOTE",provider_symbol:"XAUUSD",
    source_url:"https://biquote.io/api/XAUUSD/ohlc",
    interval,interval_seconds:intervalSeconds,status:gaps.length?"PARTIAL":"LIVE",data_quality:dataQuality,
    analysis_ready:candles.length>=60,minimum_analysis_candles:60,
    retrieved_at:new Date().toISOString(),last_candle_at:last.timestamp,
    last_candle_close_at:new Date(lastCloseTime).toISOString(),
    age_seconds:Math.max(0,Math.round(ageSeconds)),freshness_limit_seconds:freshnessLimit,candles,
    note:"Completed XAU/USD OHLC candles from BIQUOTE public read-only feed. Bars marked open are excluded. Data may contain market-closure or provider gaps; indicative data only, not a broker execution feed."
  };
}

async function fetchGoldCandles(symbol, interval) {
  let primaryError;
  try {
    return await fetchGoldCandlesFromXaus(symbol,interval);
  } catch(error) {
    primaryError=String(error?.message||"XAUS OHLC unavailable");
  }
  try {
    const fallback=await fetchGoldCandlesFromBiquote(symbol,interval);
    return {...fallback, fallback_reason:primaryError};
  } catch(error) {
    const fallbackError=String(error?.message||"unknown provider error");
    const combined=new Error("XAUS unavailable: "+primaryError+"; BIQUOTE fallback unavailable: "+fallbackError);
    combined.provider_failures=[
      {provider:"XAUS",failure_class:classifyOhlcProviderFailure(primaryError),reason:primaryError},
      {provider:"BIQUOTE",failure_class:classifyOhlcProviderFailure(fallbackError),reason:fallbackError}
    ];
    throw combined;
  }
}


const CANDLE_SOURCE_MAX_SPREAD_PCT = 0.5;
const CANDLE_SOURCE_MIN_OVERLAP = 3;

async function fetchGoldCandlesWithConsensus(symbol, interval) {
  const results = await Promise.allSettled([
    fetchGoldCandlesFromXaus(symbol, interval),
    fetchGoldCandlesFromBiquote(symbol, interval)
  ]);
  const available = results.filter(result => result.status === "fulfilled").map(result => result.value);
  const errors = results.map((result, index) => result.status === "rejected"
    ? (index === 0 ? "XAUS: " : "BIQUOTE: ") + String(result.reason?.message || "unavailable")
    : null).filter(Boolean);
  if (!available.length) {
    const error=new Error("No OHLC provider available for consensus: " + errors.join("; "));
    error.provider_failures=results.map((result,index)=>result.status==="rejected"?{
      provider:index===0?"XAUS":"BIQUOTE",
      reason:String(result.reason?.message||"Provider unavailable")
    }:null).filter(Boolean);
    throw error;
  }
  const primary = available[0];
  const providerDiagnostics = results.map((result,index) => {
    const provider=index===0?"XAUS":"BIQUOTE";
    if(result.status==="rejected") {
      const reason=String(result.reason?.message||"Provider unavailable");
      return {provider,request_status:"REJECTED",
        failure_class:classifyOhlcProviderFailure(reason),error:reason,
        candle_count:0,last_candle_at:null,last_candle_close_at:null,
        age_seconds:null,freshness_limit_seconds:null,data_quality:"UNAVAILABLE",
        analysis_ready:false};
    }
    const item=result.value;
    const latest=item.candles?.[item.candles.length-1];
    return {provider:item.provider,request_status:"FULFILLED",
      failure_class:null,error:null,candle_count:item.candles?.length??0,
      last_candle_at:latest?.timestamp??null,
      last_candle_close_at:item.last_candle_close_at??null,
      age_seconds:item.age_seconds??null,
      freshness_limit_seconds:item.freshness_limit_seconds??null,
      data_quality:item.data_quality?.status??"UNKNOWN",
      analysis_ready:item.analysis_ready===true};
  });
  const base = {
    ...primary,
    source_consensus: {
      status: "UNCONFIRMED",
      providers: available.map(item => item.provider),
      required_providers: ["XAUS", "BIQUOTE"],
      provider_diagnostics: providerDiagnostics,
      overlap_candles: 0,
      max_ohlc_spread_pct: null,
      latest_timestamp_match: false,
      errors
    }
  };
  if (available.length !== 2) {
    return {...base, source_quality: "SINGLE_SOURCE", status: "UNCONFIRMED",
      analysis_ready: false,
      note: "A second independent OHLC provider is unavailable; this feed is diagnostic only and cannot authorize a signal."};
  }

  const [xaus, biquote] = results.map(result => result.value);
  const xausLatest = xaus.candles[xaus.candles.length - 1];
  const biquoteLatest = biquote.candles[biquote.candles.length - 1];
  const latestTimestampMatch = Boolean(xausLatest && biquoteLatest &&
    xausLatest.timestamp === biquoteLatest.timestamp);
  const byTime = new Map(biquote.candles.map(candle => [candle.timestamp, candle]));
  const overlap = xaus.candles.filter(candle => byTime.has(candle.timestamp));
  const recentOverlap = overlap.slice(-CANDLE_SOURCE_MIN_OVERLAP);
  const enoughOverlap = overlap.length >= CANDLE_SOURCE_MIN_OVERLAP &&
    recentOverlap.length === CANDLE_SOURCE_MIN_OVERLAP &&
    recentOverlap[recentOverlap.length - 1]?.timestamp === xausLatest?.timestamp;

  const failConsensus = (reason, status = "UNCONFIRMED") => ({
    ...base,
    source_quality: status,
    status: "UNAVAILABLE",
    analysis_ready: false,
    source_consensus: {
      ...base.source_consensus,
      status,
      overlap_candles: overlap.length,
      latest_timestamp_match: latestTimestampMatch
    },
    note: reason
  });

  if (!latestTimestampMatch) {
    return failConsensus("Provider latest completed candle timestamps do not match; cross-source time alignment failed.");
  }
  if (!enoughOverlap) {
    return failConsensus("Providers do not share at least three recent completed candle timestamps including the latest candle.");
  }
  if (xaus.data_quality?.status !== "CLEAN" || biquote.data_quality?.status !== "CLEAN") {
    return failConsensus("At least one provider reports candle gaps or non-clean OHLC data.", "DIVERGENT");
  }

  const ohlcFields = ["open", "high", "low", "close"];
  const fieldSpreadDiagnostics = Object.fromEntries(ohlcFields.map(field => {
    let maxSpread = -Infinity;
    let candleAt = null;
    for (const candle of recentOverlap) {
      const other = byTime.get(candle.timestamp);
      const spread = Math.abs(candle[field] / other[field] - 1) * 100;
      if (spread > maxSpread) {
        maxSpread = spread;
        candleAt = candle.timestamp;
      }
    }
    return [field, {
      max_spread_pct: Math.round(maxSpread * 10000) / 10000,
      candle_at: candleAt
    }];
  }));
  const worstField = ohlcFields.reduce((worst, field) =>
    fieldSpreadDiagnostics[field].max_spread_pct >
      fieldSpreadDiagnostics[worst].max_spread_pct ? field : worst, ohlcFields[0]);
  const maxSpread = fieldSpreadDiagnostics[worstField].max_spread_pct;
  const converged = Number.isFinite(maxSpread) && maxSpread <= CANDLE_SOURCE_MAX_SPREAD_PCT;
  return {
    ...base,
    source_quality: converged ? "CONVERGED" : "DIVERGENT",
    status: converged && xaus.analysis_ready && biquote.analysis_ready ? "LIVE" : "UNAVAILABLE",
    analysis_ready: converged && xaus.analysis_ready === true && biquote.analysis_ready === true,
    source_consensus: {
      ...base.source_consensus,
      status: converged ? "CONVERGED" : "DIVERGENT",
      overlap_candles: overlap.length,
      compared_recent_candles: recentOverlap.length,
      compared_ohlc_values: recentOverlap.length * ohlcFields.length,
      max_ohlc_spread_pct: maxSpread,
      ohlc_spread_by_field_pct: Object.fromEntries(ohlcFields.map(field =>
        [field, fieldSpreadDiagnostics[field].max_spread_pct])),
      worst_ohlc_mismatch: {
        field: worstField,
        candle_at: fieldSpreadDiagnostics[worstField].candle_at,
        spread_pct: maxSpread
      },
      latest_timestamp_match: latestTimestampMatch,
      latest_common_candle_at: xausLatest.timestamp,
      tolerance_pct: CANDLE_SOURCE_MAX_SPREAD_PCT
    },
    note: converged
      ? "XAUS and BIQUOTE agree on the latest three completed candles' OHLC values and timestamps within tolerance. Indicative data only, not a broker execution feed."
      : "Cross-provider OHLC disagreement exceeds the configured tolerance; signal generation is blocked."
  };
}

function round2(v){return Math.round(v*100)/100;}
function round4(v){return Math.round(v*10000)/10000;}
function round6(v){return Math.round(v*1000000)/1000000;}

const SIGNAL_STABILITY_MIN_INTERVAL_MS = 20_000;
const SIGNAL_STABILITY_MAX_WINDOW_MS = 5 * 60_000;

async function confirmSignalStability(env, symbol, signal, markets, now = Date.now()) {
  const pending = (status, confirmations = 0) => ({
    confirmed: false, status, confirmations, required_confirmations: 2,
    minimum_interval_seconds: SIGNAL_STABILITY_MIN_INTERVAL_MS / 1000
  });
  if (!env?.SIGNAL_HISTORY) return pending("STORAGE_UNAVAILABLE");
  if (!["BUY", "SELL"].includes(signal) || !Array.isArray(markets) || markets.length !== 3 ||
      !Number.isFinite(now)) return pending("INVALID_CANDIDATE");

  const fingerprintPayload = {
    symbol, signal,
    timeframes: markets.map(market => ({
      interval: market.interval,
      last_candle_at: market.last_candle_at,
      candles: market.candles.slice(-3).map(candle => ({
        timestamp: candle.timestamp,
        open: candle.open, high: candle.high, low: candle.low, close: candle.close
      })),
      source_quality: market.source_quality,
      consensus: market.source_consensus?.status
    }))
  };
  const fingerprint = await sha256Hex(JSON.stringify(fingerprintPayload));
  const key = "signal-stability:" + symbol;
  try {
    const previous = await env.SIGNAL_HISTORY.get(key, "json");
    const previousAt = Date.parse(previous?.last_observed_at);
    const firstAt = Date.parse(previous?.first_seen_at);
    const same = previous?.fingerprint === fingerprint &&
      Number.isFinite(previousAt) && Number.isFinite(firstAt) &&
      now >= previousAt && now - firstAt <= SIGNAL_STABILITY_MAX_WINDOW_MS;

    if (!same) {
      const state = {fingerprint, first_seen_at:new Date(now).toISOString(),
        last_observed_at:new Date(now).toISOString(), confirmations:1};
      await env.SIGNAL_HISTORY.put(key, JSON.stringify(state), {expirationTtl:600});
      return pending("AWAITING_CONFIRMATION", 1);
    }

    if ((Number(previous.confirmations) || 1) >= 2) {
      return {
        confirmed:true, status:"CONFIRMED", confirmations:2, required_confirmations:2,
        minimum_interval_seconds:SIGNAL_STABILITY_MIN_INTERVAL_MS / 1000,
        first_seen_at:previous.first_seen_at,
        last_observed_at:previous.last_observed_at
      };
    }

    if (now - previousAt < SIGNAL_STABILITY_MIN_INTERVAL_MS) {
      return pending("WAITING_FOR_SEPARATED_OBSERVATION", 1);
    }

    const confirmations = Math.min(2, (Number(previous.confirmations) || 1) + 1);
    const state = {...previous, last_observed_at:new Date(now).toISOString(), confirmations};
    await env.SIGNAL_HISTORY.put(key, JSON.stringify(state), {expirationTtl:600});
    return {
      confirmed: confirmations >= 2,
      status: confirmations >= 2 ? "CONFIRMED" : "AWAITING_CONFIRMATION",
      confirmations, required_confirmations:2,
      minimum_interval_seconds:SIGNAL_STABILITY_MIN_INTERVAL_MS / 1000,
      first_seen_at:state.first_seen_at,
      last_observed_at:state.last_observed_at
    };
  } catch {
    return pending("STORAGE_UNAVAILABLE");
  }
}

async function archiveSignal(env,symbol,result) {
  if(!env?.SIGNAL_HISTORY || !result?.last_candle_at || result.market_data_status!=="LIVE")
    return {saved:false,alert_status:"NOT_CONFIGURED"};
  const candleTime=Date.parse(result.last_candle_at);
  if(!Number.isFinite(candleTime)) return {saved:false,alert_status:"INVALID_CANDLE"};
  const reverseTime=String(9999999999999-candleTime).padStart(13,"0");
  const key=symbol+":latest:"+reverseTime;
  const existing=await env.SIGNAL_HISTORY.get(key,"json");
  if(existing) return {saved:true,key,alert_status:existing.alert_status||"ALREADY_ARCHIVED"};
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
            "\nمنبع داده: "+String(result.market_provider||"تأییدنشده")+
            "؛ امتیاز احتمال موفقیت نیست و سفارش خودکار انجام نمی‌شود.",
          disable_web_page_preview:true})
      });
      alertStatus=sent.ok?"SENT":"FAILED";
    } catch { alertStatus="FAILED"; }
  }
  const record={...result,symbol,recorded_at:new Date().toISOString(),
    archive_key:key,archive_source:"validated completed OHLC multi-timeframe evaluation",
    alert_status:alertStatus,execution_enabled:false};
  await env.SIGNAL_HISTORY.put(key,JSON.stringify(record),{expirationTtl:90*24*60*60});
  return {saved:true,key,alert_status:alertStatus};
}


export async function validateArchivedSignalForTrade(env,signalId,symbol,side,now=Date.now()) {
  const invalid=(error)=>({valid:false,error});
  if(!env?.SIGNAL_HISTORY) return invalid("SIGNAL_HISTORY_UNAVAILABLE");
  if(typeof signalId!=="string"||!/^xau:latest:\d{13}$/.test(signalId))
    return invalid("INVALID_SIGNAL_REFERENCE");
  let record;
  try { record=await env.SIGNAL_HISTORY.get(signalId,"json"); }
  catch { return invalid("SIGNAL_HISTORY_UNAVAILABLE"); }
  if(!isValidArchivedSignal(record)||record.archive_key!==signalId)
    return invalid("SIGNAL_NOT_FOUND_OR_INVALID");
  const recordedAt=Date.parse(record.recorded_at);
  const candleAt=Date.parse(record.last_candle_at);
  if(!Number.isFinite(now)||!Number.isFinite(recordedAt)||!Number.isFinite(candleAt)||
     recordedAt>now+30000||now-recordedAt>60*60*1000||
     candleAt>now+30000||now-candleAt>2*60*60*1000)
    return invalid("SIGNAL_EXPIRED");
  if(record.signal!==side) return invalid("SIGNAL_SIDE_MISMATCH");
  // Historical records remain eligible for performance analytics, but only
  // fully verified current-pipeline signals can authorize paper-trade prefill.
  if(record.signal_quality?.status!=="PASSED"||
     record.signal_stability?.status!=="CONFIRMED"||
     record.signal_stability?.confirmed!==true||
     Number(record.signal_stability?.confirmations)<2||
     Number(record.signal_stability?.required_confirmations)!==2)
    return invalid("SIGNAL_NOT_VERIFIED");
  const sources=record.market_sources;
  if(!Array.isArray(sources)||sources.length!==3) return invalid("SIGNAL_NOT_VERIFIED");
  for(const interval of ["15m","60m","1d"]) {
    const source=sources.find(item=>item?.interval===interval);
    const consensus=source?.source_consensus;
    if(!source||source.source_quality!=="CONVERGED"||
       consensus?.status!=="CONVERGED"||consensus?.latest_timestamp_match!==true||
       !Number.isFinite(consensus?.overlap_candles)||consensus.overlap_candles<3||
       !Number.isFinite(consensus?.max_ohlc_spread_pct)||
       consensus.max_ohlc_spread_pct>CANDLE_SOURCE_MAX_SPREAD_PCT||
       source.data_quality?.status!=="CLEAN") return invalid("SIGNAL_NOT_VERIFIED");
  }
  const tradeSymbol=String(symbol||"").toUpperCase();
  if(record.symbol.toLowerCase()!=="xau"||!["XAU","XAUUSD","GOLD"].includes(tradeSymbol))
    return invalid("SIGNAL_SYMBOL_MISMATCH");
  try {
    const latest=await env.SIGNAL_HISTORY.list({prefix:record.symbol+":latest:",limit:1});
    if(latest.keys?.[0]?.name!==signalId) return invalid("SIGNAL_SUPERSEDED");
  } catch { return invalid("SIGNAL_HISTORY_UNAVAILABLE"); }
  return {valid:true,signal_id:signalId,signal:record.signal,recorded_at:record.recorded_at,
    expires_at:new Date(recordedAt+60*60*1000).toISOString()};
}

function isValidArchivedSignal(record) {
  if(!record || typeof record!=="object" || Array.isArray(record)) return false;
  if(!["BUY","SELL","NO_TRADE"].includes(record.signal)) return false;
  if(record.execution_enabled!==false || record.market_data_status!=="LIVE") return false;
  if(typeof record.symbol!=="string" || !/^[a-z0-9_-]{1,20}$/i.test(record.symbol)) return false;
  if(!["validated completed OHLC multi-timeframe evaluation","XAUS completed OHLC multi-timeframe evaluation"].includes(record.archive_source)) return false;
  const candleTime=Date.parse(record.last_candle_at),recordedTime=Date.parse(record.recorded_at);
  if(!Number.isFinite(candleTime)||!Number.isFinite(recordedTime)||recordedTime<candleTime) return false;
  if(!Number.isFinite(record.confidence)||record.confidence<0||record.confidence>100) return false;
  if(["BUY","SELL"].includes(record.signal)) {
    if(![record.entry,record.stop_loss,record.take_profit].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0)) return false;
    if(record.signal==="BUY" && !(record.stop_loss<record.entry&&record.take_profit>record.entry)) return false;
    if(record.signal==="SELL" && !(record.stop_loss>record.entry&&record.take_profit<record.entry)) return false;

  }
  return true;
}

function calculateSignalPerformance(records,candles,costs={fee_bps:10,slippage_bps:5,spread_bps:0}) {
  const horizons=[1,4,24];
  const times=new Map(candles.map((c,i)=>[Date.parse(c.timestamp),i]));
  const stats=Object.fromEntries(horizons.map(h=>[h,{horizon_candles:h,scored:0,pending:0,unavailable:0,
    wins:0,losses:0,flats:0,win_rate_pct:null,average_return_pct:null,
    average_favorable_pct:null,average_adverse_pct:null}]));
  const outcomes=[];
  let pending=0,unavailable=0,outsideCandleRange=0,missingCandleWithinRange=0;
  const firstCandleTime=candles.length?Date.parse(candles[0].timestamp):NaN;
  const lastCandleTime=candles.length?Date.parse(candles[candles.length-1].timestamp):NaN;
  const ordered=[...records].filter(r=>isValidArchivedSignal(r)&&["BUY","SELL"].includes(r.signal))
    .sort((a,b)=>Date.parse(b.last_candle_at)-Date.parse(a.last_candle_at));
  for(const record of ordered) {
    const signalTime=Date.parse(record.last_candle_at);
    const index=times.get(signalTime);
    if(!Number.isFinite(signalTime)||index===undefined) {
      unavailable++;
      if(Number.isFinite(signalTime)&&Number.isFinite(firstCandleTime)&&Number.isFinite(lastCandleTime)&&
          (signalTime<firstCandleTime||signalTime>lastCandleTime)) outsideCandleRange++;
      else missingCandleWithinRange++;
      for(const horizon of horizons) stats[horizon].unavailable++;
      continue;
    }
    // Classify only from candles completed at the archived signal timestamp.
    // The following entry candle and all future data are excluded from the regime label.
    const regimeSnapshot=index>=59?classifyMarketRegime(candles.slice(0,index+1)):
      {status:"INSUFFICIENT_DATA",tradeable:false};
    const confidence=Number(record.confidence);
    const confidenceBand=!Number.isFinite(confidence)?"UNAVAILABLE":
      confidence<40?"LOW_0_39":confidence<60?"MODERATE_40_59":
      confidence<80?"STRONG_60_79":"VERY_STRONG_80_100";
    const row={signal:record.signal,last_candle_at:record.last_candle_at,
      confidence_score:confidence,confidence_band:confidenceBand,
      market_regime:regimeSnapshot.status||"UNAVAILABLE",regime_tradeable:regimeSnapshot.tradeable===true,
      outcomes:{}};
    for(const horizon of horizons) {
      const end=index+horizon;
      if(end>=candles.length) {
        pending++; stats[horizon].pending++;
        row.outcomes[horizon]={status:"PENDING",required_future_candles:horizon};
        continue;
      }
      let contiguous=true;
      for(let step=1;step<=horizon;step++) {
        if(times.get(signalTime+step*3600000)!==index+step) { contiguous=false; break; }
      }
      if(!contiguous) {
        unavailable++; stats[horizon].unavailable++;
        row.outcomes[horizon]={status:"DATA_GAP"};
        continue;
      }
      const window=candles.slice(index+1,end+1);
      const entry=window[0].open, exit=window[window.length-1].close;
      if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(exit)||exit<=0) {
        unavailable++; stats[horizon].unavailable++;
        row.outcomes[horizon]={status:"INVALID_PRICE"};
        continue;
      }
      const direction=record.signal==="BUY"?1:-1;
      const grossReturnPct=direction*(exit/entry-1)*100;
      const costRate=(costs.fee_bps+costs.slippage_bps+costs.spread_bps/2)/10000;
      const adjustedEntry=entry*(1+direction*costRate);
      const adjustedExit=exit*(1-direction*costRate);
      if(!Number.isFinite(adjustedEntry)||adjustedEntry<=0||
         !Number.isFinite(adjustedExit)||adjustedExit<=0) {
        unavailable++; stats[horizon].unavailable++;
        row.outcomes[horizon]={status:"INVALID_COST_ADJUSTED_PRICE"};
        continue;
      }
      const returnPct=direction*(adjustedExit/adjustedEntry-1)*100;
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
      metric._grossReturns=(metric._grossReturns||0)+grossReturnPct;
      metric._favorable=(metric._favorable||0)+favorablePct;
      metric._adverse=(metric._adverse||0)+adversePct;
      row.outcomes[horizon]={status:"SCORED",entry_price:entry,exit_price:exit,
        gross_return_pct:round4(grossReturnPct),return_pct:round4(returnPct),
        cost_adjusted_entry_price:round6(adjustedEntry),cost_adjusted_exit_price:round6(adjustedExit),
        max_favorable_pct:round4(favorablePct),
        max_adverse_pct:round4(adversePct),entry_basis:"next_completed_candle_open"};
    }
    outcomes.push(row);
  }
  for(const horizon of horizons) {
    const m=stats[horizon];
    if(m.scored) {
      m.win_rate_pct=round2(m.wins/m.scored*100);
      m.average_return_pct=round4(m._returns/m.scored);
      m.average_net_return_pct=m.average_return_pct;
      m.average_gross_return_pct=round4(m._grossReturns/m.scored);
      m.average_favorable_pct=round4(m._favorable/m.scored);
      m.average_adverse_pct=round4(m._adverse/m.scored);
    }
    delete m._returns; delete m._grossReturns; delete m._favorable; delete m._adverse;
  }
  // Calendar-month cohorts expose regime changes without pretending overlapping
  // signal horizons form a tradable portfolio equity curve.
  const periodMap=new Map();
  for(const row of outcomes) {
    const period=String(row.last_candle_at||"").slice(0,7);
    if(!/^\d{4}-\d{2}$/.test(period)) continue;
    if(!periodMap.has(period)) periodMap.set(period,{period,horizons:Object.fromEntries(
      horizons.map(h=>[h,{horizon_candles:h,scored:0,wins:0,losses:0,flats:0,
        average_net_return_pct:null,average_gross_return_pct:null,win_rate_pct:null,
        sample_status:"INSUFFICIENT_SAMPLE",_net:0,_gross:0}]))});
    const cohort=periodMap.get(period);
    for(const horizon of horizons) {
      const outcome=row.outcomes[horizon];
      if(outcome?.status!=="SCORED") continue;
      const metric=cohort.horizons[horizon];
      metric.scored++;
      metric._net+=outcome.return_pct;
      metric._gross+=outcome.gross_return_pct;
      if(outcome.return_pct>0) metric.wins++;
      else if(outcome.return_pct<0) metric.losses++;
      else metric.flats++;
    }
  }
  const periodBreakdown=[...periodMap.values()].sort((a,b)=>a.period.localeCompare(b.period));
  // Regime cohorts use the regime known at signal close, never future candles.
  const regimeMap=new Map();
  for(const row of outcomes) {
    const regime=row.market_regime||"UNAVAILABLE";
    if(!regimeMap.has(regime)) regimeMap.set(regime,{regime,tradeable:row.regime_tradeable===true,
      horizons:Object.fromEntries(horizons.map(h=>[h,{horizon_candles:h,scored:0,wins:0,losses:0,flats:0,
        average_net_return_pct:null,win_rate_pct:null,sample_status:"INSUFFICIENT_SAMPLE",_net:0}]))});
    const cohort=regimeMap.get(regime);
    for(const horizon of horizons) {
      const outcome=row.outcomes[horizon];
      if(outcome?.status!=="SCORED") continue;
      const metric=cohort.horizons[horizon];
      metric.scored++; metric._net+=outcome.return_pct;
      if(outcome.return_pct>0) metric.wins++;
      else if(outcome.return_pct<0) metric.losses++;
      else metric.flats++;
    }
  }
  const regimeBreakdown=[...regimeMap.values()].sort((a,b)=>a.regime.localeCompare(b.regime));
  // Confidence is the minimum multi-timeframe technical confluence score, not a probability.
  // Cohorts reveal whether stronger aligned setups have historically behaved differently.
  const confidenceMap=new Map();
  for(const row of outcomes) {
    const band=row.confidence_band||"UNAVAILABLE";
    if(!confidenceMap.has(band)) confidenceMap.set(band,{confidence_band:band,score_type:"minimum_multi_timeframe_technical_confluence_not_probability",
      horizons:Object.fromEntries(horizons.map(h=>[h,{horizon_candles:h,scored:0,wins:0,losses:0,flats:0,
        average_net_return_pct:null,win_rate_pct:null,sample_status:"INSUFFICIENT_SAMPLE",_net:0}]))});
    const cohort=confidenceMap.get(band);
    for(const horizon of horizons) {
      const outcome=row.outcomes[horizon];
      if(outcome?.status!=="SCORED") continue;
      const metric=cohort.horizons[horizon];
      metric.scored++; metric._net+=outcome.return_pct;
      if(outcome.return_pct>0) metric.wins++;
      else if(outcome.return_pct<0) metric.losses++;
      else metric.flats++;
    }
  }
  const confidenceBreakdown=[...confidenceMap.values()].sort((a,b)=>
    ["LOW_0_39","MODERATE_40_59","STRONG_60_79","VERY_STRONG_80_100","UNAVAILABLE"].indexOf(a.confidence_band)-
    ["LOW_0_39","MODERATE_40_59","STRONG_60_79","VERY_STRONG_80_100","UNAVAILABLE"].indexOf(b.confidence_band));
  for(const cohort of confidenceBreakdown) for(const metric of Object.values(cohort.horizons)) {
    if(metric.scored) {
      metric.average_net_return_pct=round4(metric._net/metric.scored);
      metric.win_rate_pct=round2(metric.wins/metric.scored*100);
    }
    metric.sample_status=metric.scored>=10?"DESCRIPTIVE_SAMPLE":"INSUFFICIENT_SAMPLE";
    delete metric._net;
  }
  for(const cohort of regimeBreakdown) for(const metric of Object.values(cohort.horizons)) {
    if(metric.scored) {
      metric.average_net_return_pct=round4(metric._net/metric.scored);
      metric.win_rate_pct=round2(metric.wins/metric.scored*100);
    }
    metric.sample_status=metric.scored>=10?"DESCRIPTIVE_SAMPLE":"INSUFFICIENT_SAMPLE";
    delete metric._net;
  }
  for(const cohort of periodBreakdown) for(const metric of Object.values(cohort.horizons)) {
    if(metric.scored) {
      metric.average_net_return_pct=round4(metric._net/metric.scored);
      metric.average_gross_return_pct=round4(metric._gross/metric.scored);
      metric.win_rate_pct=round2(metric.wins/metric.scored*100);
    }
    metric.sample_status=metric.scored>=10?"DESCRIPTIVE_SAMPLE":"INSUFFICIENT_SAMPLE";
    delete metric._net; delete metric._gross;
  }
  const maximumScoredSamples=Math.max(0,...Object.values(stats).map(item=>item.scored));
  return {method:"completed_60m_candles_next_open_entry_cost_adjusted",
    cost_model:{fee_bps_per_side:costs.fee_bps,slippage_bps_per_side:costs.slippage_bps,
      spread_bps_full:costs.spread_bps,spread_bps_per_side:costs.spread_bps/2,
      applied:"adverse cost on entry and exit; BUY pays higher entry/lower exit, SELL pays lower entry/higher exit"},
    horizons:Object.values(stats),
    period_breakdown:periodBreakdown,
    regime_breakdown:regimeBreakdown,
    confidence_breakdown:confidenceBreakdown,
    confidence_breakdown_note:"Bands use the minimum 15m/60m/daily technical confluence score (0-100), not a probability of success. Results are descriptive only; fewer than 10 scored signals per horizon is marked INSUFFICIENT_SAMPLE.",
    regime_breakdown_note:"Each signal is grouped by the market regime calculated only from completed candles available at that signal close. Signals before 60 candles are INSUFFICIENT_DATA. Regime cohorts are descriptive and not portfolio returns.",
    period_breakdown_note:"UTC calendar-month cohorts of scored signals. Each signal horizon is evaluated independently; overlapping signals are not compounded and these cohorts are not portfolio returns. Fewer than 10 scored signals is marked INSUFFICIENT_SAMPLE.",
    outcomes:outcomes.slice(0,50),directional_signals:ordered.length,pending_count:pending,
    unavailable_count:unavailable,
    unavailable_diagnostics:{outside_candle_range:outsideCandleRange,
      missing_candle_within_range:missingCandleWithinRange,
      note:"Outside-range records need a wider provider history window; missing timestamps inside the available range indicate candle alignment or data gaps. Neither category is scored."},
    sample_quality:{minimum_context_samples:30,maximum_scored_samples:maximumScoredSamples,
      status:maximumScoredSamples>=30?"AT_OR_ABOVE_CONTEXT_THRESHOLD":"BELOW_CONTEXT_THRESHOLD",
      note:"30 is a practical display threshold only; it does not establish statistical significance or predict future performance."},
    execution_enabled:false,
    warning:"Historical descriptive evaluation only. Net returns deduct the explicitly displayed fee, slippage and half-spread assumptions on both entry and exit; actual broker fills may differ. Small samples are not evidence of future profitability."};
}


async function sha256Hex(value) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
function randomHex(byteLength) {
  const bytes=crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");
}

function classifyXauWeekendSession(nowMs=Date.now()) {
  if(!Number.isFinite(nowMs)) throw new Error("nowMs must be a finite timestamp");
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"America/New_York",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(new Date(nowMs));
  const values=Object.fromEntries(parts.filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  const hour=Number(values.hour),minute=Number(values.minute);
  if(!Number.isInteger(hour)||!Number.isInteger(minute)||!values.weekday)
    throw new Error("Unable to determine New York market-session clock");
  const afterFridayClose=values.weekday==="Fri"&&(hour>17||(hour===17&&minute>=0));
  const saturday=values.weekday==="Sat";
  const beforeSundayOpen=values.weekday==="Sun"&&hour<17;
  const weekendClosed=afterFridayClose||saturday||beforeSundayOpen;
  return {
    status:weekendClosed?"WEEKEND_CLOSED_ESTIMATE":"NOT_WEEKEND_CLOSED",
    is_weekend_closed_estimate:weekendClosed,
    reference_timezone:"America/New_York",
    reference_close:"Friday 17:00",
    reference_open:"Sunday 17:00",
    note:"Calendar heuristic only; broker holidays and instrument-specific trading hours may differ. This estimate never overrides quote or candle freshness checks."
  };
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
  const maxAge=provider==="Talasanj"?TALASANJ_MAX_AGE_SECONDS:provider==="XAUS"?XAUS_MAX_AGE_SECONDS:MAX_AGE_SECONDS;
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
async function fetchXausSpotQuote() {
  try {
    const response=await fetch("https://xaus.com/api/v1/spot?compact=1",{
      headers:{accept:"application/json","user-agent":"AyyarSmartTrader/1.0"},
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok) return null;
    const payload=await response.json();
    const state=payload?.data_state;
    if(state?.status!=="fresh") return null;
    const stamp=typeof state.as_of==="string"?parseStamp(state.as_of):null;
    const ageFromSource=typeof state.age_seconds==="number"?state.age_seconds:NaN;
    const ageFromTimestamp=stamp?(Date.now()-stamp.getTime())/1000:NaN;
    const rawPrice=payload?.spot_usd_oz??payload?.xau?.price;
    const price=rawPrice;
    const unit=payload?.xau?.unit;
    const currency=payload?.xau?.currency;
    const updatedAt=parseStamp(payload.updated_at);
    const updatedAge=updatedAt?(Date.now()-updatedAt.getTime())/1000:NaN;
    if(!stamp||!Number.isFinite(ageFromSource)||ageFromSource<0||ageFromSource>XAUS_MAX_AGE_SECONDS||
       !Number.isFinite(ageFromTimestamp)||ageFromTimestamp< -30||ageFromTimestamp>XAUS_MAX_AGE_SECONDS||
       !Number.isFinite(price)||price<=0||price>1e15||
       currency!=="USD"||!["oz","troy_oz"].includes(unit)||
       !Number.isFinite(updatedAge)||updatedAge< -30||updatedAge>XAUS_MAX_AGE_SECONDS) return null;
    return {id:"xau",price,unit:"USD",updated_utc:stamp.toISOString(),stale:false};
  } catch { return null; }
}
function calculateGold18kParity(snapshot,now=Date.now()) {
  const quotes=Array.isArray(snapshot?.quotes)?snapshot.quotes:[];
  const bySymbol=new Map(quotes.map(quote=>[quote.symbol,quote]));
  const required=["GOLD18","USD_IRT","XAUUSD"];
  const inputs=Object.fromEntries(required.map(symbol=>[symbol,bySymbol.get(symbol)||null]));
  const unavailable=required.filter(symbol=>{
    const quote=inputs[symbol];
    if(!quote||quote.status!=="LIVE"||!Number.isFinite(quote.price)||quote.price<=0) return true;
    const stamp=parseStamp(quote.timestamp);
    if(!stamp) return true;
    const age=(now-stamp.getTime())/1000;
    return age < -30 || age > (quote.source==="Talasanj"?TALASANJ_MAX_AGE_SECONDS:
      quote.source==="XAUS"?XAUS_MAX_AGE_SECONDS:MAX_AGE_SECONDS);
  });
  const base={status:"UNAVAILABLE",symbol:"GOLD18",unit:"تومان/گرم",
    formula:"XAUUSD × USD_IRT × 0.75 ÷ 31.1034768",
    inputs:Object.fromEntries(required.map(symbol=>[symbol,inputs[symbol]?{
      status:inputs[symbol].status,price:inputs[symbol].price,
      timestamp:inputs[symbol].timestamp,source:inputs[symbol].source}:null])),
    note:"برآورد نظری طلای ۱۸ عیار؛ بدون اجرت، مالیات، کارمزد و حباب بازار."};
  if(unavailable.length) return {...base,reason:"REQUIRED_LIVE_INPUT_MISSING",missing_inputs:unavailable};
  const stamps=required.map(symbol=>parseStamp(inputs[symbol].timestamp).getTime());
  const skewSeconds=(Math.max(...stamps)-Math.min(...stamps))/1000;
  if(skewSeconds>180) return {...base,reason:"INPUT_TIMESTAMP_SKEW",timestamp_skew_seconds:round2(skewSeconds)};
  const theoretical=inputs.XAUUSD.price*inputs.USD_IRT.price*0.75/31.1034768;
  const observed=inputs.GOLD18.price;
  if(!Number.isFinite(theoretical)||theoretical<=0||!Number.isFinite(observed)||observed<=0)
    return {...base,reason:"INVALID_PARITY_CALCULATION"};
  return {...base,status:"AVAILABLE",theoretical_price_irt_per_gram:round2(theoretical),
    observed_market_price_irt_per_gram:observed,
    premium_discount_pct:round2((observed/theoretical-1)*100),
    timestamp_skew_seconds:round2(skewSeconds),reason:null};
}

function refreshCachedSnapshotFreshness(snapshot,now=Date.now()) {
  if(!snapshot||!Array.isArray(snapshot.quotes)) return snapshot;
  const quotes=snapshot.quotes.map(quote=>{
    if(quote?.status!=="LIVE") return quote;
    const stamp=parseStamp(quote.timestamp);
    const age=stamp?(now-stamp.getTime())/1000:null;
    const maxAge=quote.source==="Talasanj"?TALASANJ_MAX_AGE_SECONDS:
      quote.source==="XAUS"?XAUS_MAX_AGE_SECONDS:MAX_AGE_SECONDS;
    const fresh=Boolean(Number.isFinite(quote.price)&&quote.price>0&&stamp&&
      age>=-30&&age<=maxAge&&quote.meta?.unit_valid===true);
    return {...quote,price:fresh?quote.price:null,status:fresh?"LIVE":"STALE",
      age_seconds:age===null?null:Math.round(age*10)/10,
      meta:{...(quote.meta||{}),reason:fresh?null:"Cached quote exceeded its source freshness limit or failed validation"}};
  });
  const liveQuotes=quotes.filter(quote=>quote.status==="LIVE").length;
  return {...snapshot,quotes,live_quotes:liveQuotes,
    status:liveQuotes===quotes.length?"LIVE":liveQuotes>0?"PARTIAL":"UNAVAILABLE",
    freshness_checked_at:new Date(now).toISOString()};
}

async function discoverAyarInstrument() {
  const endpoint="https://cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/"+encodeURIComponent("عیار");
  try {
    const response=await fetch(endpoint,{
      headers:{accept:"application/json","user-agent":"Mozilla/5.0 AyyarSmartTrader/1.0"},
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok) throw new Error("TSETMC instrument search HTTP "+response.status);
    const payload=await response.json();
    const rows=Array.isArray(payload)?payload:
      Array.isArray(payload?.instrumentSearch)?payload.instrumentSearch:
      Array.isArray(payload?.instrumentsearch)?payload.instrumentsearch:null;
    if(!rows) throw new Error("TSETMC instrument search schema is unrecognized");
    const normalize=value=>String(value??"").replace(/\u200c/g,"").replace(/\s+/g,"").trim();
    const matches=rows.filter(row=>{
      const symbol=normalize(row?.lVal18AFC??row?.symbol??row?.insName??row?.instrument?.lVal18AFC);
      return symbol==="عیار";
    }).map(row=>({
      symbol:"عیار",
      name:String(row?.lVal30??row?.name??row?.instrument?.lVal30??"").slice(0,120),
      ins_code:String(row?.insCode??row?.inscode??row?.instrument?.insCode??"")
    })).filter(row=>/^\d{8,20}$/.test(row.ins_code));
    if(matches.length!==1) return {
      status:"UNAVAILABLE",symbol:"AYAR",source:"TSETMC",
      reason:matches.length===0?"EXACT_SYMBOL_NOT_FOUND":"AMBIGUOUS_EXACT_SYMBOL_MATCH",
      candidate_count:matches.length,retrieved_at:new Date().toISOString(),
      execution_enabled:false,
      note:"Instrument identity is not confirmed. No fund quote, NAV, or trading signal is inferred."
    };
    return {status:"IDENTIFIED",symbol:"AYAR",ticker:matches[0].symbol,
      instrument_name:matches[0].name,ins_code:matches[0].ins_code,
      source:"TSETMC",source_url:endpoint,retrieved_at:new Date().toISOString(),
      next_step:"Instrument identity only; live price, NAV, timestamp alignment and liquidity remain unverified.",
      execution_enabled:false};
  } catch(error) {
    return {status:"UNAVAILABLE",symbol:"AYAR",source:"TSETMC",
      reason:String(error?.message||"TSETMC instrument discovery failed").slice(0,240),
      retrieved_at:new Date().toISOString(),execution_enabled:false,
      note:"No instrument code or market price is guessed when TSETMC discovery is unavailable."};
  }
}


function tsetmcLocalTimestamp(deven,hEven) {
  if(!Number.isInteger(Number(deven))||!Number.isInteger(Number(hEven))) return null;
  const date=String(deven).padStart(8,"0"),time=String(hEven).padStart(6,"0");
  if(!/^\\d{8}$/.test(date)||!/^\\d{6}$/.test(time)) return null;
  const y=Number(date.slice(0,4)),m=Number(date.slice(4,6)),d=Number(date.slice(6,8));
  const hh=Number(time.slice(0,2)),mm=Number(time.slice(2,4)),ss=Number(time.slice(4,6));
  if(m<1||m>12||d<1||d>31||hh>23||mm>59||ss>59) return null;
  // TSETMC dEven/hEven are Tehran local time (UTC+03:30).
  const utc=Date.UTC(y,m-1,d,hh,mm,ss)-210*60*1000;
  const check=new Date(utc+210*60*1000);
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d) return null;
  return utc;
}

async function fetchAyarMarketSnapshot(insCode,now=Date.now()) {
  const base="https://cdn.tsetmc.com/api/";
  const headers={accept:"application/json","user-agent":"Mozilla/5.0 AyyarSmartTrader/1.0"};
  const request=async path=>{
    const response=await fetch(base+path,{headers,signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw new Error("TSETMC HTTP "+response.status+" for "+path.split("/")[0]);
    return response.json();
  };
  try {
    const [quotePayload,bookPayload,navPayload]=await Promise.all([
      request("ClosingPrice/GetClosingPriceInfo/"+insCode),
      request("BestLimits/"+insCode),
      request("Fund/GetETFByInsCode/"+insCode)
    ]);
    const quote=quotePayload?.closingPriceInfo;
    const nav=navPayload?.etf;
    const book=bookPayload?.bestLimits;
    if(!quote||String(quote.insCode)!==String(insCode)||!nav||
       String(nav.insCode)!==String(insCode)||!Array.isArray(book))
      throw new Error("TSETMC Ayar response schema or instrument identity mismatch");
    const last=Number(quote.pDrCotVal),close=Number(quote.pClosing);
    const redemptionNav=Number(nav.pRedTran),subscriptionNav=Number(nav.pSubTran);
    const quoteAt=tsetmcLocalTimestamp(quote.dEven,quote.hEven);
    const navAt=tsetmcLocalTimestamp(nav.deven,nav.hEven);
    const quoteAge=quoteAt===null?null:(now-quoteAt)/1000;
    const navAge=navAt===null?null:(now-navAt)/1000;
    const active=String(quote.instrumentState?.cEtaval??"").trim()==="A"||
      String(quote.instrumentState?.cEtavalTitle??"").trim()==="مجاز";
    const fresh=quoteAge!==null&&navAge!==null&&quoteAge>=-30&&navAge>=-30&&
      quoteAge<=1200&&navAge<=1200&&Math.abs(quoteAt-navAt)<=300000;
    const validPrices=[last,close,redemptionNav,subscriptionNav].every(v=>Number.isFinite(v)&&v>0&&v<=1e15);
    if(!fresh||!validPrices||!active)
      throw new Error(!fresh?"TSETMC quote/NAV timestamps are stale or misaligned":
        !active?"Ayar instrument is not in an active permitted state":"TSETMC returned invalid price or NAV values");
    const levels=book.map(level=>({
      bid_price:Number(level?.pd),bid_volume:Number(level?.qd),
      ask_price:Number(level?.po),ask_volume:Number(level?.qo)
    })).filter(level=>[level.bid_price,level.bid_volume,level.ask_price,level.ask_volume]
      .every(v=>Number.isFinite(v)&&v>=0));
    const top=levels[0];
    if(!top||top.bid_price<=0||top.ask_price<=0||top.bid_volume<=0||top.ask_volume<=0||
       top.ask_price<top.bid_price)
      throw new Error("TSETMC order book is empty or invalid");
    const premium=(last/redemptionNav-1)*100;
    return {
      status:"LIVE",symbol:"AYAR",source:"TSETMC",ins_code:String(insCode),
      currency_unit:"RIAL",price:last,closing_price:close,
      redemption_nav:redemptionNav,subscription_nav:subscriptionNav,
      premium_discount_pct:Number(premium.toFixed(4)),
      quote_at:new Date(quoteAt).toISOString(),nav_at:new Date(navAt).toISOString(),
      quote_age_seconds:Math.round(quoteAge),nav_age_seconds:Math.round(navAge),
      best_bid:{price:top.bid_price,volume:top.bid_volume},
      best_ask:{price:top.ask_price,volume:top.ask_volume},
      order_book_levels:levels.length,
      traded_count:Number.isFinite(Number(quote.zTotTran))?Number(quote.zTotTran):null,
      traded_value_rial:Number.isFinite(Number(quote.qTotCap))?Number(quote.qTotCap):null,
      execution_enabled:false,
      note:"TSETMC is an undocumented public data surface. This is a market-data diagnostic, not broker execution or an investment signal."
    };
  } catch(error) {
    return {status:"UNAVAILABLE",symbol:"AYAR",source:"TSETMC",
      reason:String(error?.message||"Ayar market snapshot unavailable").slice(0,240),
      retrieved_at:new Date(now).toISOString(),execution_enabled:false,
      note:"No stale, partial, mismatched, or inferred quote/NAV/order-book values are published."};
  }
}

async function snapshot(env={}) {
  if(cached && cached.status!=="UNAVAILABLE" && Date.now()-cachedAt<(cached.quotes?.[0]?.source==="Talasanj"?15000:60000)) {
    cached=refreshCachedSnapshotFreshness(cached);
    return cached;
  }
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
    const xauIndex=SYMBOLS.findIndex(def=>def[2]==="xau");
    if(xauIndex>=0&&quotes[xauIndex].status!=="LIVE") {
      const xausQuote=await fetchXausSpotQuote();
      if(xausQuote) quotes[xauIndex]=normalise(xausQuote,SYMBOLS[xauIndex],"XAUS");
    }
    const liveQuotes=quotes.filter(q=>q.status==="LIVE").length;
    const status=liveQuotes===quotes.length?"LIVE":liveQuotes>0?"PARTIAL":"UNAVAILABLE";
    const mixedSources=quotes.some(q=>q.source==="XAUS");
    cached={status,live_quotes:liveQuotes,total_quotes:quotes.length,
      as_of:new Date().toISOString(),provider_generated_at:parseStamp(payload.generated_utc)?.toISOString()??null,
      quotes,notice:mixedSources?"XAU/USD may use XAUS spot fallback; Iranian rates retain their own provider timestamps. Indicative prices only, not broker execution quotes.":"Talasanj refreshes about every 20 seconds; NerkhAra refreshes about every ten minutes. Indicative market data only, not broker execution quotes. Stale or unavailable prices never produce signals.",
      attribution:mixedSources?(provider==="Talasanj"?"اونس جهانی از XAUS؛ سایر نرخ‌ها از طلاسنج":"اونس جهانی از XAUS؛ سایر نرخ‌ها از NerkhAra"):(provider==="Talasanj"?"قیمت‌ها از طلاسنج — https://talasanj.info":"NerkhAra — https://nerkhara.com")};
  } catch(e) {
    const quotes=SYMBOLS.map(def=>normalise(null,def));
    const xauIndex=SYMBOLS.findIndex(def=>def[2]==="xau");
    if(xauIndex>=0) {
      const xausQuote=await fetchXausSpotQuote();
      if(xausQuote) quotes[xauIndex]=normalise(xausQuote,SYMBOLS[xauIndex],"XAUS");
    }
    const liveQuotes=quotes.filter(q=>q.status==="LIVE").length;
    cached={status:liveQuotes===quotes.length?"LIVE":liveQuotes>0?"PARTIAL":"UNAVAILABLE",
      as_of:new Date().toISOString(),provider_generated_at:null,
      live_quotes:liveQuotes,total_quotes:SYMBOLS.length,quotes,
      notice:liveQuotes?"XAU/USD is supplied by the XAUS spot fallback; other provider quotes remain unavailable. No synthetic prices are displayed.":"Market data providers are unavailable or stale. No synthetic prices are displayed.",
      error:String(e?.name||"ProviderError"),attribution:liveQuotes?"اونس جهانی از XAUS — https://xaus.com؛ سایر نرخ‌ها ناموجود":"NerkhAra — https://nerkhara.com"};
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
    const sessionEstimate=classifyXauWeekendSession(Number.isFinite(scheduledTime)?scheduledTime:Date.now());
    if(sessionEstimate.is_weekend_closed_estimate) return await savePaperMonitorStatus(env,{
      status:"MARKET_CLOSED",market_session:sessionEstimate,accounts_checked:0,
      trades_processed:0,closed_trades:0,
      scheduled_at:new Date(scheduledTime).toISOString(),started_at:startedAt,
      completed_at:new Date().toISOString(),execution_enabled:false,mode:"PAPER_ONLY",
      note:"Weekend closure is a calendar estimate only. No provider freshness rule was relaxed and no paper positions were changed."
    });
    const market=await fetchGoldCandles("xau","15m");
    if(!["LIVE","PARTIAL"].includes(market.status)||!["XAUS","BIQUOTE"].includes(market.provider)||!market.candles?.length)
      throw new Error("Fresh completed XAU/USD 15m candles from an approved provider unavailable; no paper positions were changed");
    if(market.data_quality?.status!=="CLEAN"||market.data_quality?.missing_intervals>0)
      throw new Error("XAU/USD 15m feed contains "+Number(market.data_quality?.gap_count||0)+
        " candle gap(s) and "+Number(market.data_quality?.missing_intervals||0)+
        " missing interval(s); paper positions were not changed");
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
      provider_failures:Array.isArray(error?.provider_failures)?error.provider_failures.slice(0,2).map(item=>({
        provider:String(item.provider||"unknown"),
        failure_class:String(item.failure_class||"UNKNOWN_FAILURE"),
        reason:String(item.reason||"Provider unavailable").slice(0,240)
      })):[],
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
        if(market.status!=="LIVE"||market.provider!=="XAUS"||
          !Array.isArray(market.candles)||market.candles.length===0||
          market.data_quality?.status!=="CLEAN"||market.data_quality?.missing_intervals>0)
          throw new Error("Fresh, continuous XAUS 15m candles unavailable; paper positions were not changed");
        const candle=market.candles[market.candles.length-1];
        if(!candle||!Number.isFinite(Date.parse(candle.timestamp))||
          (market.last_candle_at&&market.last_candle_at!==candle.timestamp))
          throw new Error("Latest XAUS candle timestamp is invalid; paper positions were not changed");
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
    const paperAccountAuxMatch=url.pathname.match(/^\/v1\/paper\/accounts\/([a-f0-9]{32})\/(notifications|report\/daily|report\/performance|analytics\/strategy|integrity)$/);
    if(paperAccountAuxMatch&&request.method==="GET") {
      const accountId=paperAccountAuxMatch[1],resource=paperAccountAuxMatch[2];
      const auth=request.headers.get("authorization")||"";
      if(!auth.startsWith("Bearer ")) return json({error:"Bearer authorization required"},401);
      const bearer=auth.slice(7);
      if(bearer.length<32||bearer.length>256) return json({error:"Invalid bearer token"},401);
      const tokenHash=await sha256Hex(bearer);
      const account=env.PAPER_ACCOUNTS.getByName(accountId);
      try {
        if(resource==="integrity") {
          const report=await account.getIntegrityReport(tokenHash);
          if(report===null) return json({error:"Account not found or access denied"},404);
          return json(report);
        }
        if(resource==="notifications") {
          const notifications=await account.listNotifications(tokenHash,30);
          if(notifications===null) return json({error:"Account not found or access denied"},404);
          return json({notifications,execution_enabled:false,mode:"PAPER_ONLY"});
        }
        if(resource==="analytics/strategy") {
          const analytics=await account.getStrategyAttribution(tokenHash);
          if(analytics===null) return json({error:"Account not found or access denied"},404);
          return json(analytics);
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
          const strategyId=payload.strategy_id??null,signalId=payload.signal_id??null,signalType=payload.signal_type??null;
          const feeBps=payload.fee_bps??5;
          const idem=payload.idempotency_key;
          if(typeof symbol!=="string"||!/^[A-Z0-9._-]{2,32}$/.test(symbol)||
             !["BUY","SELL"].includes(side)||
             ![quantity,entry_price,stop_loss,take_profit,feeBps].every(v=>typeof v==="number"&&Number.isFinite(v))||
             quantity<=0||Number(quantity.toFixed(6))!==quantity||
             entry_price<=0||stop_loss<=0||take_profit<=0||feeBps<0||feeBps>1000||
             (side==="BUY"&&(stop_loss>=entry_price||take_profit<=entry_price))||
             (side==="SELL"&&(stop_loss<=entry_price||take_profit>=entry_price))||
             (idem!==undefined&&(typeof idem!=="string"||idem.length<8||idem.length>128))||
             (strategyId!==null&&(typeof strategyId!=="string"||!/^[A-Za-z0-9._:-]{1,64}$/.test(strategyId)))||
             (signalId!==null&&(typeof signalId!=="string"||!/^[A-Za-z0-9._:-]{1,96}$/.test(signalId)))||
             (signalType!==null&&(!["BUY","SELL"].includes(signalType)))||
             ((signalId===null)!==(signalType===null))||
             (signalType!==null&&signalType!==side))
            return json({error:"Invalid trade: use positive numeric values, directional stop/target and a valid optional idempotency_key"},400);
          if(signalId!==null) {
            const validation=await validateArchivedSignalForTrade(env,signalId,symbol,side,Date.now());
            if(!validation.valid) return json({error:validation.error,execution_enabled:false},409);
          }
          const result=await account.createTrade(tokenHash,{trade_id:randomHex(16),symbol,side,quantity,entry_price,stop_loss,take_profit,fee_bps:feeBps,idempotency_key:idem??null,
            strategy_id:strategyId,signal_id:signalId,signal_type:signalType},new Date().toISOString());
          if(result===null) return json({error:"Account not found or access denied"},404);
          if(result.error) return json(result,409);
          return json({...result,mode:"PAPER_ONLY",trading_enabled:false,execution_enabled:false},201);
        } catch(e) {
          const message=String(e?.message||"Paper trade could not be recorded");
          const status=message==="INSUFFICIENT_PAPER_BALANCE"||message==="RISK_LIMIT_EXCEEDED"||message==="TOTAL_OPEN_RISK_LIMIT_EXCEEDED"||message==="DAILY_LOSS_LIMIT_EXCEEDED"||message==="MAX_DRAWDOWN_LIMIT_EXCEEDED"||message.includes("open paper trade already exists")?409:503;
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
    if(url.pathname==="/v1/paper-trading/backtest"&&request.method==="POST") {
      try {
        const length=Number(request.headers.get("content-length")||0);
        if(length>2048) return json({error:"Backtest configuration is too large"},413);
        const payload=await request.json();
        if(!payload||typeof payload!=="object"||Array.isArray(payload))
          return json({error:"Request body must be a JSON object"},400);
        const symbol=payload.symbol??"xau",interval=payload.interval??"60m";
        if(symbol!=="xau"||!["15m","60m","1d"].includes(interval))
          return json({error:"Historical backtest currently supports global XAU/USD only, at 15m, 60m, or 1d intervals."},400);
        const market=await fetchGoldCandles(symbol,interval);
        if(market.candles.length<60)
          return json({error:"Not enough verified completed candles for backtest",available_candles:market.candles.length,required_candles:60},422);
        const result=simulatePaperTrading({...payload,candles:market.candles});
        return json({...result,symbol,interval,provider:market.provider,
          source_url:market.source_url,retrieved_at:market.retrieved_at,
          last_candle_at:market.last_candle_at,data_quality:market.data_quality,
          history_note:"Backtest uses only the historical window currently supplied by the public XAUS chart feed; this is not a multi-year or statistically conclusive test."});
      } catch(e) {
        return json({error:String(e?.message||"Historical paper backtest failed"),
          mode:"PAPER_ONLY",execution_enabled:false},502);
      }
    }
    if(url.pathname==="/v1/paper-trading/simulate"&&request.method==="POST") {
      try {
        const payload=await request.json();
        return json(simulatePaperTrading(payload));
      } catch(e) {
        return json({error:String(e?.message||"Paper simulation failed"),mode:"PAPER_ONLY",
          execution_enabled:false},400);
      }
    }
    if(url.pathname==="/v1/market/ayar/discovery"&&request.method==="GET")
      return json(await discoverAyarInstrument());
    if(url.pathname==="/v1/market/ayar/snapshot"&&request.method==="GET") {
      const identity=await discoverAyarInstrument();
      if(identity.status!=="IDENTIFIED") return json({...identity,market_status:"UNAVAILABLE"});
      return json({...await fetchAyarMarketSnapshot(identity.ins_code),instrument:identity});
    }
    if(url.pathname==="/v1/market/quotes"&&request.method==="GET") return json(await snapshot(env));
    if(url.pathname==="/v1/market/gold18-parity"&&request.method==="GET") {
      const market=await snapshot(env);
      return json(calculateGold18kParity(market));
    }
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
        const markets=await Promise.all(intervals.map(interval=>fetchGoldCandlesWithConsensus(symbol,interval)));
        let gold18Parity;
        try {
          gold18Parity=calculateGold18kParity(await snapshot(env));
        } catch(error) {
          gold18Parity={status:"UNAVAILABLE",symbol:"GOLD18",reason:"PARITY_DIAGNOSTIC_UNAVAILABLE",
            note:"Parity diagnostic failed closed; it does not affect the XAU signal gate."};
        }
        const analyses=markets.map((market,i)=>evaluateSignal({
          candles:market.candles,timeframe_minutes:market.interval_seconds/60
        }));
        const byInterval=Object.fromEntries(intervals.map((interval,i)=>[interval,{
          signal:analyses[i].signal,proposed_signal:analyses[i].proposed_signal,
          confidence:analyses[i].confidence,confluence_score:analyses[i].confluence_score,
          signal_quality:analyses[i].signal_quality,trend:analyses[i].trend,
          confidence_type:analyses[i].confidence_type,
          last_candle_at:markets[i].last_candle_at,
          data_status:analyses[i].data_status||markets[i].status,
          data_quality:markets[i].data_quality,
          source_quality:markets[i].source_quality,
          source_consensus:markets[i].source_consensus
        }]));
        const regimes=markets.map(market=>classifyMarketRegime(market.candles));
        for(let i=0;i<intervals.length;i++) byInterval[intervals[i]].regime=regimes[i];
        const intraday=analyses[1].signal;
        const shortAligned=analyses[0].signal===intraday;
        const regimeAllowsTrade=regimes[1].tradeable&&regimes[1].trend===(intraday==="BUY"?"BULLISH":"BEARISH");
        const expectedTrend=intraday==="BUY"?"BULLISH":"BEARISH";
        const trendAligned=analyses.every(analysis=>analysis.trend===expectedTrend);
        const dataQualityClean=markets.every(market=>
          market.status==="LIVE" &&
          market.analysis_ready===true &&
          market.data_quality?.status==="CLEAN" &&
          market.source_quality==="CONVERGED" &&
          market.source_consensus?.status==="CONVERGED"
        ) && analyses.every(analysis=>![ "STALE","GAPPED","MISALIGNED","UNAVAILABLE" ].includes(analysis.data_status));
        const candidateAligned=intraday!=="NO_TRADE"&&shortAligned&&trendAligned&&regimeAllowsTrade&&dataQualityClean;
        const stability=candidateAligned
          ? await confirmSignalStability(env,symbol,intraday,markets,
            typeof env?.__signalClock==="function"?env.__signalClock():Date.now())
          : {confirmed:false,status:"NO_DIRECTIONAL_CANDIDATE",confirmations:0,required_confirmations:2};
        const stabilityPending=candidateAligned&&!stability.confirmed;
        const aligned=candidateAligned&&stability.confirmed;
        const base=analyses[1];
        const blockedReasons=[];
        if(analyses.some(a=>a.signal==="NO_TRADE"&&a.proposed_signal!=="NO_TRADE"))
          blockedReasons.push("At least one timeframe produced a directional candidate that failed its market-regime quality gate.");
        if(!dataQualityClean) blockedReasons.push("At least one timeframe lacks clean candles or verified XAUS/BIQUOTE source consensus.");
        if(!regimes[1].tradeable) blockedReasons.push("60m regime blocks entries: "+regimes[1].reason);
        if(intraday==="NO_TRADE") blockedReasons.push("60m timeframe has no qualified directional setup.");
        else if(!shortAligned) blockedReasons.push("15m and 60m directional signals disagree.");
        if(!trendAligned) blockedReasons.push("EMA trend is not aligned across 15m, 60m and daily timeframes.");
        if(stabilityPending) blockedReasons.push("Directional setup is awaiting a second identical verified observation at least 20 seconds later.");
        const qualityChecks=[
          {id:"15m_signal",passed:analyses[0].signal!=="NO_TRADE"&&analyses[0].signal===intraday},
          {id:"60m_signal",passed:intraday!=="NO_TRADE"},
          {id:"daily_trend",passed:trendAligned},
          {id:"60m_market_regime",passed:regimeAllowsTrade},
          {id:"all_timeframe_data_quality_and_source_consensus",passed:dataQualityClean},
          {id:"signal_temporal_stability",passed:!candidateAligned||stability.confirmed}
        ];
        const result={
          signal:aligned?intraday:"NO_TRADE",
          signal_quality:{status:aligned?"PASSED":"BLOCKED",checks:qualityChecks,
            passed_checks:qualityChecks.filter(x=>x.passed).length,
            required_checks:qualityChecks.length,blocked_reasons:blockedReasons},
          confidence:aligned?Math.min(analyses[0].confidence,analyses[1].confidence,analyses[2].confidence):0,
          confidence_type:"multi_timeframe_alignment_score_not_probability",
          trend:base.trend,rsi_14:base.rsi_14,macd_histogram:base.macd_histogram,atr_14:base.atr_14,
          entry:aligned?base.entry:null,stop_loss:aligned?base.stop_loss:null,
          take_profit:aligned?base.take_profit:null,risk_reward_ratio:aligned?2:null,
          timeframes:byInterval,market_data_status:dataQualityClean?"LIVE":"DEGRADED",
          gold18_parity:gold18Parity,
          signal_stability:stability,
          market_provider:[...new Set(markets.flatMap(market=>market.source_consensus?.providers||[market.provider]))].join("+"),
          market_sources:markets.map(market=>({interval:market.interval,provider:market.provider,
            source_url:market.source_url,
            fallback_reason:market.source_consensus?.errors?.join("; ")||market.fallback_reason||null,
            last_candle_at:market.last_candle_at,analysis_ready:market.analysis_ready===true,
            market_status:market.status,data_quality:market.data_quality,
            source_quality:market.source_quality,source_consensus:market.source_consensus})),
          last_candle_at:markets[1].last_candle_at,
          market_regime:regimes[1],
          reasons:aligned?["15m and 60m signals agree","15m, 60m and daily EMA trends all confirm direction","60m market regime is trending and volatility is within limits","Entry levels use the 60m candle"]:blockedReasons,
          execution_enabled:false,
          warning:"Multi-timeframe research signal only. Indicative global XAU/USD data; no broker orders are placed."
        };
        if(stabilityPending) {
          result.archive_status="WAITING_FOR_STABILITY";
          result.alert_status="NOT_SENT";
        } else {
          try {
            const archive=await archiveSignal(env,symbol,result);
            result.archive_status=archive.saved?"SAVED":"SKIPPED";
            result.alert_status=archive.alert_status;
            if(archive.saved&&archive.key) result.signal_id=archive.key;
          } catch { result.archive_status="UNAVAILABLE";result.alert_status="UNAVAILABLE"; }
        }
        return json(result);
      } catch(e) {
        const reason=String(e?.message||"Multi-timeframe OHLC data unavailable");
        const providerFailures=Array.isArray(e?.provider_failures)?e.provider_failures:[];
        const providerDiagnostics=["XAUS","BIQUOTE"].map(provider=>{
          const failure=providerFailures.find(item=>item.provider===provider);
          return {provider,status:failure?classifyOhlcProviderFailure(failure.reason):"NOT_CHECKED",
            reason:failure?.reason||null};
        });
        const sessionEstimate=classifyXauWeekendSession();
        const unavailableTimeframes=Object.fromEntries(intervals.map(interval=>[interval,{
          signal:"NO_TRADE",proposed_signal:"NO_TRADE",confidence:0,
          data_status:"UNAVAILABLE",data_quality:{status:"UNAVAILABLE",reason},
          source_quality:"UNAVAILABLE",
          source_consensus:{status:"UNAVAILABLE",required_providers:["XAUS","BIQUOTE"],
            providers:[],provider_diagnostics:providerDiagnostics,errors:providerFailures.map(item=>item.provider+": "+item.reason)},
          reason
        }]));
        return json({
          signal:"NO_TRADE",confidence:0,signal_quality:{status:"BLOCKED",
            checks:[{id:"all_timeframe_data_quality_and_source_consensus",passed:false}],
            passed_checks:0,required_checks:1,
            blocked_reasons:["Multi-timeframe market data is unavailable; directional signals are blocked."]},
          data_status:"UNAVAILABLE",market_data_status:"DEGRADED",
          signal_stability:{status:"UNAVAILABLE",confirmed:false,confirmations:0,required_confirmations:2},
          timeframes:unavailableTimeframes,provider_diagnostics:providerDiagnostics,
          session_estimate:sessionEstimate,
          market_sources:intervals.map(interval=>({interval,status:"UNAVAILABLE",
            data_quality:{status:"UNAVAILABLE",reason},source_quality:"UNAVAILABLE",
            source_consensus:unavailableTimeframes[interval].source_consensus})),
          reason,execution_enabled:false,
          warning:"Provider failure classes and XAU weekend session are diagnostic only. Session estimates never override stale or invalid OHLC checks. All three real completed timeframes are required; no synthetic candles or orders are produced."
        });
      }
    }
    if(url.pathname==="/v1/signals/performance"&&request.method==="GET") {
      if(!env?.SIGNAL_HISTORY) return json({status:"UNAVAILABLE",error:"Signal history storage is not configured",execution_enabled:false},503);
      try {
        const historyKeys=[];
        let cursor,historyPages=0;
        while(true) {
          const page=await env.SIGNAL_HISTORY.list({prefix:"xau:latest:",limit:1000,...(cursor?{cursor}:{})});
          historyPages++;
          historyKeys.push(...(page.keys||[]));
          if(page.list_complete!==false) break;
          if(!page.cursor) throw new Error("Signal history pagination cursor is missing; performance evaluation is incomplete");
          cursor=page.cursor;
          if(historyKeys.length>=3000) throw new Error("Signal history exceeded the safe 90-day scan bound; performance evaluation is incomplete");
        }
        const records=(await Promise.all(historyKeys.map(item=>env.SIGNAL_HISTORY.get(item.name,"json")))).filter(Boolean);
        const validRecords=records.filter(isValidArchivedSignal);
        const directionalRecords=validRecords.filter(record=>["BUY","SELL"].includes(record.signal));
        const archiveQuality={fetched_records:records.length,valid_records:validRecords.length,
          invalid_records:records.length-validRecords.length,
          directional_records:directionalRecords.length,
          non_directional_records:validRecords.length-directionalRecords.length,
          note:"Invalid archive entries and valid NO_TRADE records are excluded from directional outcome scoring."};
        const costs={fee_bps:Number(url.searchParams.get("fee_bps")??10),
          slippage_bps:Number(url.searchParams.get("slippage_bps")??5),
          spread_bps:Number(url.searchParams.get("spread_bps")??0)};
        if(!Object.values(costs).every(Number.isFinite)||costs.fee_bps<0||costs.fee_bps>500||
           costs.slippage_bps<0||costs.slippage_bps>500||costs.spread_bps<0||costs.spread_bps>500)
          return json({status:"INVALID_ARGUMENT",error:"fee_bps, slippage_bps and spread_bps must each be between 0 and 500"},400);
        const market=await fetchGoldCandles("xau","60m");
        const result=calculateSignalPerformance(records,market.candles,costs);
        const firstCandle=market.candles[0];
        const lastCandle=market.candles[market.candles.length-1];
        const coverageDays=firstCandle&&lastCandle
          ? Math.max(0,(Date.parse(lastCandle.timestamp)-Date.parse(firstCandle.timestamp))/86400000) : 0;
        const historyCoverage={requested_retention_days:90,
          first_candle_at:firstCandle?.timestamp||null,last_candle_at:lastCandle?.timestamp||null,
          coverage_days:round2(coverageDays),candle_count:market.candles.length,
          covers_retention_window:coverageDays>=89};
        return json({status:"OK",symbol:"xau",provider:market.provider,market_last_candle_at:market.last_candle_at,
          candle_data_quality:market.data_quality,history_coverage:historyCoverage,
          archive_quality:archiveQuality,record_count:records.length,history_pages:historyPages,...result});
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
        const valid=records.filter(isValidArchivedSignal).sort((a,b)=>Date.parse(b.recorded_at)-Date.parse(a.recorded_at));
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
        total_quotes:s.quotes.length,session_estimate:classifyXauWeekendSession(),attribution:s.attribution});
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
        const safety={sizing_status:"ESTIMATE_ONLY",data_verified:false,broker_specs_verified:false,
          order_authorized:false,execution_enabled:false};
        if(daily>=0.03) return json({...safety,allowed:false,lots:0,
          reason:"Daily loss limit reached; trading is blocked."});
        if(drawdown>=0.08) return json({...safety,allowed:false,lots:0,
          reason:"Maximum drawdown limit reached; trading is blocked."});
        const effectiveRisk=Math.min(risk,0.01),riskAmount=equity*effectiveRisk;
        const stopDistance=Math.abs(entry-stop),lossPerLot=stopDistance*contract;
        const rawLots=riskAmount/lossPerLot;
        if(!Number.isFinite(riskAmount)||!Number.isFinite(stopDistance)||!Number.isFinite(lossPerLot)||lossPerLot<=0||!Number.isFinite(rawLots)||rawLots<=0)
          return json({error:"Position sizing overflow or underflow; review equity, stop distance, and contract value."},400);
        const steppedLots=Math.floor((rawLots+lotStep*1e-10)/lotStep)*lotStep;
        const brokerMaxLots=Math.floor((maxLot+lotStep*1e-10)/lotStep)*lotStep;
        const lots=Number(Math.min(steppedLots,brokerMaxLots).toFixed(8));
        if(!Number.isFinite(lots)||lots<minLot)
          return json({...safety,allowed:false,lots:0,raw_lots:rawLots,risk_amount:riskAmount,
            lot_step:lotStep,min_lot:minLot,max_lot:maxLot,
            reason:"Calculated size is below the broker minimum lot after rounding down; trade is blocked."});
        const estimatedLoss=lots*lossPerLot;
        if(!Number.isFinite(estimatedLoss)||estimatedLoss<=0||estimatedLoss>riskAmount*(1+1e-9))
          return json({error:"Rounded position size exceeds the configured risk budget."},400);
        return json({...safety,allowed:true,lots,raw_lots:rawLots,lot_step:lotStep,min_lot:minLot,max_lot:maxLot,
          risk_amount:riskAmount,risk_fraction:effectiveRisk,stop_distance:stopDistance,
          estimated_loss_at_stop:estimatedLoss,unused_risk_budget:Math.max(0,riskAmount-estimatedLoss),
          reason:"Estimate only: broker contract specifications and account data are not authenticated. This response never authorizes an order; verify tick value, margin, spread and broker rules independently."});
      } catch { return json({error:"Request body must be valid JSON"},400); }
    }
    if(url.pathname==="/v1/backtest/ema-crossover/live"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      const readNumber=(key,fallback)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):fallback;
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const result=runBacktest({
          candles:market.candles,timeframe_minutes:market.interval_seconds/60,
          starting_capital:readNumber("starting_capital",10000),
          fee_bps:readNumber("fee_bps",10),
          slippage_bps:readNumber("slippage_bps",5),
          spread_bps:readNumber("spread_bps",0)
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
              const result=runBacktest({candles:market.candles,timeframe_minutes:market.interval_seconds/60,
                fast_period:fast,slow_period:slow,starting_capital:10000,fee_bps:10,slippage_bps:5});
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
    if(url.pathname==="/v1/backtest/strategy-comparison"&&request.method==="POST") {
      try { return json(runStrategyComparison(await request.json())); }
      catch(e) { return json({status:"UNAVAILABLE",error:String(e?.message||"Strategy comparison unavailable"),execution_enabled:false},400); }
    }
    if(url.pathname==="/v1/backtest/strategy-comparison/oos"&&request.method==="POST") {
      try { return json(runOutOfSampleStrategyComparison(await request.json())); }
      catch(e) { return json({status:"UNAVAILABLE",error:String(e?.message||"Out-of-sample comparison unavailable"),execution_enabled:false},400); }
    }
    if(url.pathname==="/v1/backtest/strategy-comparison/oos/live"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      const readNumber=(key,fallback)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):fallback;
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const result=runOutOfSampleStrategyComparison({candles:market.candles,
          timeframe_minutes:market.interval_seconds/60,starting_capital:readNumber("starting_capital",10000),
          fee_bps:readNumber("fee_bps",10),slippage_bps:readNumber("slippage_bps",5),
          spread_bps:readNumber("spread_bps",0),fast_period:readNumber("fast_period",20),
          slow_period:readNumber("slow_period",50),atr_period:readNumber("atr_period",14),
          atr_stop_multiple:readNumber("atr_stop_multiple",2),
          reward_risk_multiple:readNumber("reward_risk_multiple",1.5),risk_fraction:readNumber("risk_fraction",0.01)});
        return json({...result,market_symbol:symbol,market_interval:market.interval,
          market_data_status:market.status,market_provider:market.provider,
          market_last_candle_at:market.last_candle_at,data_note:market.note});
      } catch(e) {
        return json({status:"UNAVAILABLE",market_symbol:symbol,market_interval:interval,
          error:String(e?.message||"Out-of-sample market data unavailable"),execution_enabled:false},502);
      }
    }
    if(url.pathname==="/v1/backtest/strategy-comparison/live"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      const readNumber=(key,fallback)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):fallback;
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const result=runStrategyComparison({candles:market.candles,
          timeframe_minutes:market.interval_seconds/60,starting_capital:readNumber("starting_capital",10000),
          fee_bps:readNumber("fee_bps",10),slippage_bps:readNumber("slippage_bps",5),
          spread_bps:readNumber("spread_bps",0),fast_period:readNumber("fast_period",20),
          slow_period:readNumber("slow_period",50),atr_period:readNumber("atr_period",14),
          atr_stop_multiple:readNumber("atr_stop_multiple",2),
          reward_risk_multiple:readNumber("reward_risk_multiple",1.5),
          risk_fraction:readNumber("risk_fraction",0.01)});
        return json({...result,market_symbol:symbol,market_interval:market.interval,
          market_data_status:market.status,market_provider:market.provider,
          market_last_candle_at:market.last_candle_at,data_note:market.note});
      } catch(e) {
        return json({status:"UNAVAILABLE",market_symbol:symbol,market_interval:interval,
          error:String(e?.message||"Live strategy comparison unavailable"),execution_enabled:false},502);
      }
    }
    if(url.pathname==="/v1/backtest/atr-risk"&&request.method==="POST") {
      try { return json(runAtrRiskBacktest(await request.json())); }
      catch(e) { return json({error:String(e?.message||"Invalid ATR risk backtest request"),execution_enabled:false},400); }
    }
    if(url.pathname==="/v1/backtest/atr-risk/live"&&request.method==="GET") {
      const symbol=url.searchParams.get("symbol")||"xau";
      const interval=url.searchParams.get("interval")||"60m";
      const readNumber=(key,fallback)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):fallback;
      try {
        const market=await fetchGoldCandles(symbol,interval);
        const result=runAtrRiskBacktest({candles:market.candles,timeframe_minutes:market.interval_seconds/60,
          starting_capital:readNumber("starting_capital",10000),fee_bps:readNumber("fee_bps",10),
          slippage_bps:readNumber("slippage_bps",5),spread_bps:readNumber("spread_bps",0),
          risk_fraction:readNumber("risk_fraction",0.01),
          atr_stop_multiple:readNumber("atr_stop_multiple",2),reward_risk_multiple:readNumber("reward_risk_multiple",1.5)});
        return json({...result,market_symbol:symbol,market_provider:market.provider,
          market_interval:market.interval,market_data_status:market.status,
          market_last_candle_at:market.last_candle_at,candle_count:market.candles.length,data_note:market.note});
      } catch(e) {
        return json({status:"UNAVAILABLE",market_symbol:symbol,market_interval:interval,
          error:String(e?.message||"ATR risk backtest unavailable"),execution_enabled:false},502);
      }
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
        const result=runWalkForward({candles:market.candles,timeframe_minutes:market.interval_seconds/60,
          starting_capital:url.searchParams.has("starting_capital")?Number(url.searchParams.get("starting_capital")):10000,
          fee_bps:url.searchParams.has("fee_bps")?Number(url.searchParams.get("fee_bps")):10,
          slippage_bps:url.searchParams.has("slippage_bps")?Number(url.searchParams.get("slippage_bps")):5,
          spread_bps:url.searchParams.has("spread_bps")?Number(url.searchParams.get("spread_bps")):0});
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
export { classifyOhlcProviderFailure, classifyXauWeekendSession };
