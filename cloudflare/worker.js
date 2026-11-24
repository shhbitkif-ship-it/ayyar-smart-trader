import { handleTelegramWebhook } from "./telegram.js";
import { fetchTalasanj } from "./providers.js";
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
  if (!payload || !Array.isArray(payload.candles) || payload.candles.length < 60 || payload.candles.length > 5000)
    throw new Error("candles must contain between 60 and 5000 OHLC records");
  const candles = payload.candles.map(c => {
    const row = {timestamp:Date.parse(c?.timestamp),open:Number(c?.open),high:Number(c?.high),low:Number(c?.low),close:Number(c?.close)};
    if (!Number.isFinite(row.timestamp) || ![row.open,row.high,row.low,row.close].every(Number.isFinite) ||
        row.open<=0 || row.high<=0 || row.low<=0 || row.close<=0 ||
        row.high < Math.max(row.open,row.close,row.low) || row.low > Math.min(row.open,row.close,row.high))
      throw new Error("Each candle must contain a valid timestamp and consistent positive OHLC prices");
    return {...row,iso:new Date(row.timestamp).toISOString()};
  }).sort((a,b)=>a.timestamp-b.timestamp);
  if (candles.some((c,i)=>i>0 && c.timestamp===candles[i-1].timestamp))
    throw new Error("Candle timestamps must be unique");
  const starting = Number(payload.starting_capital ?? 10000);
  const fee = Number(payload.fee_bps ?? 10);
  const slippage = Number(payload.slippage_bps ?? 5);
  if (!Number.isFinite(starting)||starting<=0||!Number.isFinite(fee)||fee<0||fee>500||
      !Number.isFinite(slippage)||slippage<0||slippage>500)
    throw new Error("starting_capital must be positive and fee/slippage must be between 0 and 500 bps");
  const closes=candles.map(c=>c.close), slow=ema(closes,50), fastAligned=ema(closes,20).slice(30);
  const cost=(fee+slippage)/10000;
  let cash=starting, quantity=0, entryPrice=null, entryTime=null;
  const trades=[], equityCurve=[{timestamp:candles[0].iso,equity:round2(starting)}];
  // Mark equity at every candle close; this captures intra-trade drawdowns,
  // rather than measuring drawdown only when a trade closes.
  for(let candleIndex=1;candleIndex<candles.length;candleIndex++){
    const signalIndex=candleIndex-50;
    if(signalIndex>=1 && signalIndex<slow.length){
      const prevUp=fastAligned[signalIndex-1]>slow[signalIndex-1];
      const nowUp=fastAligned[signalIndex]>slow[signalIndex];
      const up=!prevUp&&nowUp, down=prevUp&&!nowUp;
      const fill=candles[candleIndex].open;
      if(down&&quantity>0){
        const exitPrice=fill*(1-cost), proceeds=quantity*exitPrice;
        const pnl=proceeds-quantity*entryPrice;
        cash=proceeds;
        trades.push({entry_time:entryTime,exit_time:candles[candleIndex].iso,
          entry_price:round6(entryPrice),exit_price:round6(exitPrice),pnl:round2(pnl),
          return_pct:round4((exitPrice/entryPrice-1)*100)});
        quantity=0;entryPrice=null;entryTime=null;
      } else if(up&&quantity===0){
        entryPrice=fill*(1+cost);quantity=cash/entryPrice;cash=0;entryTime=candles[candleIndex].iso;
      }
    }
    const equity=quantity===0?cash:quantity*candles[candleIndex].close;
    equityCurve.push({timestamp:candles[candleIndex].iso,equity:round2(equity)});
  }
  const finalEquity=quantity===0?cash:quantity*candles[candles.length-1].close;
  let peak=starting,maxDrawdown=0;
  for(const point of equityCurve){peak=Math.max(peak,point.equity);if(peak>0)maxDrawdown=Math.max(maxDrawdown,(peak-point.equity)/peak);}
  const wins=trades.filter(t=>t.pnl>0).length;
  const profit=trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const loss=Math.abs(trades.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0));
  return {strategy:"EMA20/EMA50 long-only crossover",
    execution:"Signal confirmed at candle close; orders filled at next candle open",
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
function round2(v){return Math.round(v*100)/100;}
function round4(v){return Math.round(v*10000)/10000;}
function round6(v){return Math.round(v*1000000)/1000000;}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status,headers:{
    "content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "access-control-allow-origin":"*"
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
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{headers:{
      "access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS",
      "access-control-allow-headers":"content-type"}});
    if(url.pathname==="/telegram/webhook" && request.method==="POST")
      return handleTelegramWebhook(request, env, snapshot, json);
    if(url.pathname==="/health") return json({status:"ok",service:"ayyar-smart-trader-api",version:"1.0.0"});
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
    if(url.pathname==="/v1/market/status"&&request.method==="GET") {
      const s=await snapshot(env);
      return json({status:s.status,as_of:s.as_of,live_quotes:s.quotes.filter(q=>q.status==="LIVE").length,
        total_quotes:s.quotes.length,attribution:s.attribution});
    }
    if(url.pathname==="/v1/risk/policy"&&request.method==="GET") return json({
      default_risk_per_trade:0.01,max_daily_loss:0.03,max_drawdown:0.08,execution_enabled:false,
      note:"Policy defaults only. No broker connection or automatic order execution."});
    if(url.pathname==="/v1/risk/position-size"&&request.method==="POST") {
      try {
        const p=await request.json();
        const equity=Number(p.equity),entry=Number(p.entry),stop=Number(p.stop_loss);
        const contract=Number(p.contract_value_per_price_unit);
        const risk=Number(p.risk_fraction??0.01),daily=Number(p.daily_loss_fraction??0),drawdown=Number(p.drawdown_fraction??0);
        if(![equity,entry,stop,contract,risk,daily,drawdown].every(Number.isFinite) ||
           equity<=0||entry<=0||stop<=0||contract<=0||risk<=0||risk>0.01||daily<0||daily>1||drawdown<0||drawdown>1||entry===stop)
          return json({error:"Invalid position sizing inputs"},400);
        if(daily>=0.03) return json({allowed:false,lots:0,reason:"Daily loss limit reached; trading is blocked."});
        if(drawdown>=0.08) return json({allowed:false,lots:0,reason:"Maximum drawdown limit reached; trading is blocked."});
        const effectiveRisk=Math.min(risk,0.01),riskAmount=equity*effectiveRisk;
        const stopDistance=Math.abs(entry-stop),lossPerLot=stopDistance*contract;
        const lots=riskAmount/lossPerLot;
        if(!Number.isFinite(riskAmount)||!Number.isFinite(stopDistance)||!Number.isFinite(lossPerLot)||lossPerLot<=0||!Number.isFinite(lots)||lots<=0)
          return json({error:"Position sizing overflow or underflow; review equity, stop distance, and contract value."},400);
        return json({allowed:true,lots,risk_amount:riskAmount,risk_fraction:effectiveRisk,
          stop_distance:stopDistance,estimated_loss_at_stop:lots*lossPerLot,
          reason:"Sizing estimate only. Confirm tick value, lot step, margin, spread and broker rules before any order."});
      } catch { return json({error:"Request body must be valid JSON"},400); }
    }
    if(url.pathname==="/v1/backtest/ema-crossover"&&request.method==="POST") {
      try { return json(runBacktest(await request.json())); }
      catch(e) { return json({error:String(e?.message||"Invalid backtest request")},400); }
    }
    if(url.pathname==="/v1/signals/evaluate"&&request.method==="POST") return json({
      signal:"NO_TRADE",confidence:0,
      reason:"Technical-history validation and independent signal verification are not enabled in this public-data build.",
      execution_enabled:false});
    return json({error:"Not found"},404);
  }
};