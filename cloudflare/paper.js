const finite = value => typeof value === "number" && Number.isFinite(value);
const round = (value, digits=8) => Number(value.toFixed(digits));

function ema(values, period) {
  if(values.length<period) return [];
  const alpha=2/(period+1);
  const out=[values.slice(0,period).reduce((a,b)=>a+b,0)/period];
  for(const value of values.slice(period)) out.push(alpha*value+(1-alpha)*out[out.length-1]);
  return out;
}

export function simulatePaperTrading(payload) {
  if(!payload||!Array.isArray(payload.candles)||payload.candles.length<60||payload.candles.length>5000)
    throw new Error("Paper simulation requires 60 to 5000 real OHLC candles");
  const fast=payload.fast_period??20,slow=payload.slow_period??50;
  const capital=payload.starting_capital??10000,risk=payload.risk_fraction??0.01;
  const contract=payload.contract_value_per_price_unit;
  const fee=payload.fee_bps??10,slippage=payload.slippage_bps??5;
  if(![fast,slow].every(Number.isInteger)||fast<2||slow<=fast||slow>200||
    ![capital,risk,contract,fee,slippage].every(finite)||capital<=0||risk<=0||risk>0.01||
    contract<=0||fee<0||fee>500||slippage<0||slippage>500)
    throw new Error("Invalid paper trading configuration; provide finite numeric capital, risk, contract value and costs");
  const candles=payload.candles.map((c,i)=>{
    const timestamp=Date.parse(c?.timestamp);
    const open=c?.open,high=c?.high,low=c?.low,close=c?.close;
    if(!Number.isFinite(timestamp)||![open,high,low,close].every(finite)||
      [open,high,low,close].some(v=>v<=0||v>1e15)||high<Math.max(open,close,low)||low>Math.min(open,close,high))
      throw new Error("Invalid OHLC candle at index "+i);
    if(i>0&&timestamp<=Date.parse(payload.candles[i-1]?.timestamp))
      throw new Error("Paper simulation candle timestamps must be strictly increasing and unique");
    return {timestamp:new Date(timestamp).toISOString(),open,high,low,close};
  });
  const closes=candles.map(c=>c.close),fastEma=ema(closes,fast),slowEma=ema(closes,slow);
  const alignedFast=fastEma.slice(slow-fast),trades=[];
  let equity=capital,position=null,peak=capital,maxDrawdown=0;
  const curve=[{timestamp:candles[0].timestamp,equity:round(equity,2)}];
  const costRate=(fee+slippage)/10000;
  const closePosition=(index,rawExit,reason)=>{
    const c=candles[index],exit=rawExit*(1-costRate);
    const gross=(exit-position.entry_price)*position.quantity*contract;
    const exitFee=rawExit*position.quantity*contract*fee/10000;
    const net=gross-position.entry_fee-exitFee;
    if(![exit,gross,exitFee,net].every(Number.isFinite)) throw new Error("Paper trade result exceeded numeric limits");
    equity+=net;
    trades.push({entry_time:position.entry_time,exit_time:c.timestamp,entry_price:round(position.entry_price),
      exit_price:round(exit),quantity:round(position.quantity),stop_loss:round(position.stop_loss),
      take_profit:round(position.take_profit),gross_pnl:round(gross,2),fees:round(position.entry_fee+exitFee,2),
      net_pnl:round(net,2),exit_reason:reason,equity_after:round(equity,2)});
    position=null;
  };
  for(let i=1;i<candles.length;i++){
    const c=candles[i],signalIndex=i-slow+1;
    if(position){
      let exit=null,reason=null;
      if(c.open<=position.stop_loss){exit=c.open;reason="STOP_GAP";}
      else if(c.open>=position.take_profit){exit=position.take_profit;reason="TAKE_PROFIT_GAP";}
      else {
        const stopHit=c.low<=position.stop_loss,tpHit=c.high>=position.take_profit;
        if(stopHit){exit=position.stop_loss;reason="STOP_LOSS";} // conservative if both levels trade in one candle
        else if(tpHit){exit=position.take_profit;reason="TAKE_PROFIT";}
      }
      if(exit!==null) closePosition(i,exit,reason);
    }
    if(!position&&signalIndex>=1&&signalIndex<slowEma.length){
      const crossedUp=alignedFast[signalIndex-1]<=slowEma[signalIndex-1]&&alignedFast[signalIndex]>slowEma[signalIndex];
      if(crossedUp&&i+1<candles.length){
        const prior=candles.slice(Math.max(1,i-14),i+1);
        const ranges=prior.map((x,j)=>Math.max(x.high-x.low,Math.abs(x.high-candles[Math.max(0,Math.max(1,i-14)+j-1)].close),Math.abs(x.low-candles[Math.max(0,Math.max(1,i-14)+j-1)].close)));
        const atr=ranges.reduce((a,b)=>a+b,0)/ranges.length;
        const distance=atr*1.5,rawEntry=candles[i+1].open,entry=rawEntry*(1+costRate);
        const riskAmount=equity*risk;
        const stop=entry-distance,target=entry+distance*2;
        const entryFeePerUnit=rawEntry*contract*fee/10000;
        const exitFeePerUnit=stop*contract*fee/10000;
        const lossPerUnit=(entry-stop*(1-costRate))*contract+entryFeePerUnit+exitFeePerUnit;
        const quantity=riskAmount/lossPerUnit;
        const entryFee=rawEntry*quantity*contract*fee/10000;
        if(![atr,distance,entry,riskAmount,lossPerUnit,quantity,stop,target,entryFee].every(Number.isFinite)||
          atr<=0||distance<=0||quantity<=0||lossPerUnit<=0||stop<=0||target<=entry)
          throw new Error("Paper position sizing exceeded numeric limits");
        position={entry_time:candles[i+1].timestamp,entry_price:entry,quantity,stop_loss:stop,take_profit:target,entry_fee:entryFee};
      }
    }
    const mark=position?equity+(c.close-position.entry_price)*position.quantity*contract-position.entry_fee:equity;
    if(!Number.isFinite(mark)) throw new Error("Paper equity exceeded numeric limits");
    peak=Math.max(peak,mark);maxDrawdown=Math.max(maxDrawdown,(peak-mark)/peak);
    curve.push({timestamp:c.timestamp,equity:round(mark,2)});
  }
  const last=candles[candles.length-1];
  const openPosition=position?{entry_time:position.entry_time,entry_price:round(position.entry_price),
    quantity:round(position.quantity),stop_loss:round(position.stop_loss),take_profit:round(position.take_profit),
    unrealized_pnl:round((last.close-position.entry_price)*position.quantity*contract-position.entry_fee,2)}:null;
  const finalEquity=position?equity+openPosition.unrealized_pnl:equity;
  if(!Number.isFinite(finalEquity)||finalEquity<=0) throw new Error("Paper account equity is outside the supported range");
  const wins=trades.filter(t=>t.net_pnl>0).length;
  return {mode:"PAPER_ONLY",strategy:"EMA crossover with ATR stop and 2R target",fast_period:fast,slow_period:slow,
    starting_capital:round(capital,2),realized_equity:round(equity,2),final_equity:round(finalEquity,2),
    net_return_pct:round((finalEquity/capital-1)*100,4),max_drawdown_pct:round(maxDrawdown*100,4),
    closed_trades:trades.length,win_rate_pct:trades.length?round(wins/trades.length*100,2):0,
    open_position:openPosition,trades,equity_curve:curve,
    cost_model:{fee_bps_per_side:fee,slippage_bps_per_side:slippage},
    execution_enabled:false,persistent_account:false,
    warning:"Stateless historical paper simulation only. Results are not saved as a persistent account, use supplied OHLC only, and never place broker orders. Same-candle stop and target touches are resolved conservatively as stop first."};
}
