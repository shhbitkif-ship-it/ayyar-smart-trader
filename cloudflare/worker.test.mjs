import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "./worker_core.js";
import { calculateLegacyPaperBalance, calculatePaperEntryFee, calculatePaperSettlement, ledgerEventReplayMatches } from "./ledger_math.mjs";

const originalFetch = globalThis.fetch;
const freshItems = [
  ["gold-18k","IRT",7200000],["gold-24k","IRT",9600000],
  ["gold-mesghal","IRT",31200000],["coin-emami","IRT",78000000],
  ["coin-half","IRT",42000000],["coin-quarter","IRT",25000000],
  ["usd","IRT",70000],["xau","USD",2650]
].map(([id,unit,price]) => ({id,unit,price,updated_utc:new Date().toISOString(),stale:false}));

test("paper ledger fee and settlement math reconciles BUY and SELL positions",()=>{
  const buyEntryFee=calculatePaperEntryFee(0.1,2000,5);
  const buyExitFee=calculatePaperEntryFee(0.1,2010,5);
  const buy=calculatePaperSettlement({side:"BUY",quantity:0.1,entryPrice:2000,
    exitPrice:2010,entryFee:buyEntryFee,exitFee:buyExitFee});
  assert.equal(buyEntryFee,0.1);
  assert.equal(buy.gross,1);
  assert.equal(buy.totalFees,0.2005);
  assert.equal(buy.realizedPnl,0.7995);
  assert.equal(buy.ledgerCloseAmount,0.8995);
  assert.ok(Math.abs((10000-buyEntryFee+buy.ledgerCloseAmount)-(10000+buy.realizedPnl))<1e-10);

  const sellEntryFee=calculatePaperEntryFee(0.2,100,10);
  const sellExitFee=calculatePaperEntryFee(0.2,105,10);
  const sell=calculatePaperSettlement({side:"SELL",quantity:0.2,entryPrice:100,
    exitPrice:105,entryFee:sellEntryFee,exitFee:sellExitFee});
  assert.equal(sell.gross,-1);
  assert.equal(sell.realizedPnl,-1.041);
  assert.equal(sell.ledgerCloseAmount,-1.021);
  assert.ok(Math.abs((5000-sellEntryFee+sell.ledgerCloseAmount)-(5000+sell.realizedPnl))<1e-10);
});

test("legacy paper balance ignores unverified partial ledger rows",()=>{
  const balance=calculateLegacyPaperBalance({
    startingCapital:10000,realizedPnl:125,openFees:4
  });
  assert.equal(balance,10121);
  assert.throws(()=>calculateLegacyPaperBalance({
    startingCapital:10000,realizedPnl:Infinity,openFees:4
  }),/INVALID_LEGACY_PAPER_BALANCE_INPUT/);
  assert.throws(()=>calculateLegacyPaperBalance({
    startingCapital:10000,realizedPnl:125,openFees:-1
  }),/INVALID_LEGACY_PAPER_BALANCE_INPUT/);
});

test("paper ledger idempotency accepts only exact event replays",()=>{
  const original={event_type:"TRADE_CLOSED",amount:12.5,metadata_json:JSON.stringify({
    trade_id:"trade-1",symbol:"XAUUSD",realized_pnl:12.5
  }),created_at:"2026-11-25T08:00:00.000Z"};
  const event={eventType:"TRADE_CLOSED",amount:12.5,
    metadata:{realized_pnl:12.5,symbol:"XAUUSD",trade_id:"trade-1"},
    createdAt:"2026-11-25T08:00:00.000Z"};
  assert.equal(ledgerEventReplayMatches(original,event),true);
  assert.equal(ledgerEventReplayMatches(original,{...event,amount:12.6}),false);
  assert.equal(ledgerEventReplayMatches(original,{...event,createdAt:"2026-11-25T08:01:00.000Z"}),false);
  assert.equal(ledgerEventReplayMatches(original,{...event,metadata:{...event.metadata,trade_id:"trade-2"}}),false);
  assert.equal(ledgerEventReplayMatches({...original,metadata_json:"not-json"},event),false);
  assert.equal(ledgerEventReplayMatches(null,event),false);
});

test("paper ledger fee and settlement math rejects invalid and non-finite values",()=>{
  assert.throws(()=>calculatePaperEntryFee(0,100,5),/INVALID_PAPER_FEE_INPUT/);
  assert.throws(()=>calculatePaperEntryFee(1,100,1001),/INVALID_PAPER_FEE_INPUT/);
  assert.throws(()=>calculatePaperEntryFee(1,Infinity,5),/INVALID_PAPER_FEE_INPUT/);
  assert.throws(()=>calculatePaperSettlement({side:"HOLD",quantity:1,entryPrice:100,
    exitPrice:101,entryFee:0,exitFee:0}),/INVALID_PAPER_SETTLEMENT_INPUT/);
  assert.throws(()=>calculatePaperSettlement({side:"BUY",quantity:1,entryPrice:100,
    exitPrice:101,entryFee:-1,exitFee:0}),/INVALID_PAPER_SETTLEMENT_INPUT/);
});

test("health endpoint responds", async () => {
  const response = await worker.fetch(new Request("https://unit.test/health"));
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,"ok");
});

test("fresh quotes require correct units and timestamps", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    generated_utc:new Date().toISOString(),
    items:freshItems
  }),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response = await worker.fetch(new Request("https://unit.test/v1/market/quotes"));
    const body = await response.json();
    assert.equal(response.status,200);
    assert.equal(body.quotes.length,8);
    assert.ok(body.quotes.every(q => q.status==="LIVE" && q.price>0));
    assert.equal(body.quotes.find(q=>q.symbol==="GOLD18").unit,"تومان");
    assert.equal(body.quotes.find(q=>q.symbol==="XAUUSD").unit,"USD/oz");
  } finally { globalThis.fetch = originalFetch; }
});

test("XAUS fresh spot is used only as a validated XAU quote fallback when NerkhAra is unavailable",async()=>{
  const isolatedWorker=(await import("./worker_core.js?xaus-spot-fallback-test")).default;
  globalThis.fetch=async(url)=>{
    if(String(url).includes("nerkhara.com")) return new Response("provider unavailable",{status:503});
    if(String(url).includes("xaus.com/api/v1/spot")){
      const now=new Date().toISOString();
      return new Response(JSON.stringify({spot_usd_oz:4123.45,
        xau:{price:4123.45,currency:"USD",unit:"oz"},
        data_state:{status:"fresh",as_of:now,age_seconds:0},updated_at:now}),
        {status:200,headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected provider URL: "+url);
  };
  try{
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/quotes"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.status,"PARTIAL");
    assert.equal(body.live_quotes,1);
    const xau=body.quotes.find(q=>q.symbol==="XAUUSD");
    assert.equal(xau.status,"LIVE");
    assert.equal(xau.source,"XAUS");
    assert.equal(xau.price,4123.45);
    assert.ok(body.quotes.filter(q=>q.symbol!=="XAUUSD").every(q=>q.status==="UNAVAILABLE"));
  }finally{globalThis.fetch=originalFetch;}
});

test("XAUS spot fallback rejects stale or non-fresh source data",async()=>{
  const isolatedWorker=(await import("./worker_core.js?xaus-spot-stale-fallback-test")).default;
  globalThis.fetch=async(url)=>{
    if(String(url).includes("nerkhara.com")) return new Response("provider unavailable",{status:503});
    if(String(url).includes("xaus.com/api/v1/spot")){
      const stale=new Date(Date.now()-10*60*1000).toISOString();
      return new Response(JSON.stringify({spot_usd_oz:4123.45,
        xau:{price:4123.45,currency:"USD",unit:"oz"},
        data_state:{status:"stale",as_of:stale,age_seconds:600},updated_at:new Date().toISOString()}),
        {status:200,headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected provider URL: "+url);
  };
  try{
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/quotes"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.status,"UNAVAILABLE");
    assert.equal(body.live_quotes,0);
    assert.ok(body.quotes.every(q=>q.status==="UNAVAILABLE"));
  }finally{globalThis.fetch=originalFetch;}
});

test("signal endpoint rejects missing OHLC history", async () => {
  const response=await worker.fetch(new Request("https://unit.test/v1/signals/evaluate",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})
  }));
  const body=await response.json();
  assert.equal(response.status,400);
  assert.equal(body.signal,"NO_TRADE");
  assert.equal(body.execution_enabled,false);
});

test("signal endpoint blocks stale candles", async () => {
  const candles=[];
  for(let i=0;i<80;i++){
    const close=200+i*0.1;
    candles.push({timestamp:new Date(Date.UTC(2020,0,1+i)).toISOString(),open:close,high:close+0.2,low:close-0.2,close});
  }
  const response=await worker.fetch(new Request("https://unit.test/v1/signals/evaluate",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({candles,timeframe_minutes:60})
  }));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.signal,"NO_TRADE");
  assert.equal(body.data_status,"STALE");
  assert.equal(body.execution_enabled,false);
});

test("signal endpoint blocks fresh but gapped candle history", async () => {
  const candles=[];
  let close=100;
  for(let i=0;i<80;i++){
    const previous=close;
    close+=i%2===0?0.5:-0.3;
    if(i===79) close=previous+0.5;
    const candleIndex=i<40?i:i+1;
    candles.push({timestamp:new Date(Date.now()-(80-candleIndex)*3600000).toISOString(),
      open:previous,high:Math.max(previous,close)+0.2,low:Math.min(previous,close)-0.2,close});
  }
  const response=await worker.fetch(new Request("https://unit.test/v1/signals/evaluate",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({candles,timeframe_minutes:60})
  }));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.signal,"NO_TRADE");
  assert.equal(body.data_status,"GAPPED");
  assert.equal(body.gap_count,1);
  assert.equal(body.missing_intervals,1);
  assert.equal(body.execution_enabled,false);
});

test("signal endpoint computes a bounded technical confluence score from fresh candles", async () => {
  const candles=[];
  let close=100;
  for(let i=0;i<120;i++){
    const previous=close;
    close+=i%2===0?0.5:-0.3;
    if(i===119) close=previous+0.5;
    candles.push({timestamp:new Date(Date.now()-(119-i)*3600000).toISOString(),
      open:previous,high:Math.max(previous,close)+0.2,low:Math.min(previous,close)-0.2,close});
  }
  const response=await worker.fetch(new Request("https://unit.test/v1/signals/evaluate",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({candles,timeframe_minutes:60})
  }));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.signal,"BUY");
  assert.equal(body.confidence,100);
  assert.ok(body.entry>0&&body.stop_loss>0&&body.take_profit>body.entry);
  assert.equal(body.risk_reward_ratio,2);
  assert.equal(body.execution_enabled,false);
  assert.equal(body.confidence_type,"technical_confluence_score_not_probability");
});

test("signal quality gate blocks a strong confluence setup during excessive volatility",async()=>{
 const candles=[];let close=100;
 for(let i=0;i<120;i++){
  const previous=close;close+=i%2===0?0.5:-0.3;if(i===119)close=previous+0.5;
  const spike=i===119?20:0.2;
  candles.push({timestamp:new Date(Date.now()-(119-i)*3600000).toISOString(),
   open:previous,high:Math.max(previous,close)+spike,low:Math.min(previous,close)-spike,close});
 }
 const response=await worker.fetch(new Request("https://unit.test/v1/signals/evaluate",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({candles,timeframe_minutes:60})
 }));
 const body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body));
 assert.equal(body.proposed_signal,"BUY");
 assert.equal(body.signal,"NO_TRADE");
 assert.equal(body.confidence,0);
 assert.equal(body.signal_quality.blocked_by_regime,true);
 assert.equal(body.market_regime.status,"HIGH_VOLATILITY");
 assert.equal(body.execution_enabled,false);
});

test("signal endpoint fails closed", async () => {
  const response = await worker.fetch(new Request("https://unit.test/v1/signals/evaluate",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})
  }));
  const body = await response.json();
  assert.equal(body.signal,"NO_TRADE");
  assert.equal(body.execution_enabled,false);
});

test("risk policy disables execution and caps risk", async () => {
  const policy = await (await worker.fetch(new Request("https://unit.test/v1/risk/policy"))).json();
  assert.equal(policy.execution_enabled,false);
  assert.equal(policy.default_risk_per_trade,0.01);
});


test("position sizing rejects numeric overflow and underflow", async () => {
  const response = await worker.fetch(new Request("https://unit.test/v1/risk/position-size", {
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({
      equity:1e100,entry:1e-200,stop_loss:2e-200,
      contract_value_per_price_unit:1e-100
    })
  }));
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/overflow or underflow/i);
});

test("position sizing blocks daily loss limit", async () => {
  const response = await worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({equity:100000,entry:100,stop_loss:95,contract_value_per_price_unit:1,daily_loss_fraction:0.03})
  }));
  const body = await response.json();
  assert.equal(body.allowed,false);
  assert.equal(body.lots,0);
});


test("daily history endpoint proxies and labels daily mean data", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    id:"gold-18k",
    data:[{date:"2026-11-23",price:27000000},{date:"2026-11-22",price:26800000}]
  }),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response = await worker.fetch(new Request("https://unit.test/v1/market/history?symbol=gold-18k"));
    const body = await response.json();
    assert.equal(response.status,200);
    assert.equal(body.symbol,"gold-18k");
    assert.equal(body.granularity,"1d");
    assert.equal(body.value_type,"daily_mean");
    assert.equal(body.series.data.length,2);
  } finally { globalThis.fetch = originalFetch; }
});

test("history endpoint rejects symbols outside the allowlist", async () => {
  const response = await worker.fetch(new Request("https://unit.test/v1/market/history?symbol=../../secrets"));
  assert.equal(response.status,400);
});



test("live OHLC backtest runs from the verified XAUS feed without manual candle upload", async () => {
  const originalFetch=globalThis.fetch;
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:120},(_,i)=>{
    const close=i<55?3100-i*2:i<90?2990+(i-55)*5:3165-(i-90)*4;
    return {timestamp:new Date(lastClosed-(119-i)*intervalMs).toISOString(),
      open:close,high:close+3,low:close-3,close};
  });
  let requested="";
  globalThis.fetch=async url=>{
    requested=String(url);
    return new Response(JSON.stringify(xausChartFixture(candles)),
      {status:200,headers:{"content-type":"application/json"}});
  };
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover/live?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.match(requested,/xaus\.com\/api\/v1\/chart/);
    assert.equal(body.market_provider,"XAUS");
    assert.equal(body.market_data_status,"LIVE");
    assert.equal(body.market_interval,"60m");
    assert.equal(body.candle_count,120);
    assert.ok("net_return_pct" in body && "max_drawdown_pct" in body);
    assert.equal(body.cost_model.fee_bps_per_side,10);
    assert.equal(body.cost_model.slippage_bps_per_side,5);
    assert.equal(body.execution_enabled,undefined);
    assert.ok(body.warning.startsWith("Research only"));
  } finally { globalThis.fetch=originalFetch; }
});

test("live OHLC backtest fails closed when the provider is unavailable", async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response("provider unavailable",{status:503});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover/live?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,502);
    assert.equal(body.status,"UNAVAILABLE");
    assert.equal(body.execution_enabled,false);
  } finally { globalThis.fetch=originalFetch; }
});

test("EMA backtest returns cost-aware metrics from valid OHLC candles", async () => {
  const candles = [];
  for (let i=0;i<150;i++) {
    const close = i<70 ? 3100-i*2 : i<110 ? 2960+(i-70)*5 : 3160-(i-110)*5;
    candles.push({
      timestamp:new Date(Date.UTC(2025,0,1+i)).toISOString(),
      open:close,high:close+3,low:close-3,close
    });
  }
  const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({candles})
  }));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.strategy,"EMA20/EMA50 long-only crossover");
  assert.ok(body.closed_trades>=1);
  assert.equal(body.cost_model.fee_bps_per_side,10);
  assert.equal(body.cost_model.slippage_bps_per_side,5);
  assert.ok("max_drawdown_pct" in body);
  assert.equal(body.equity_curve.length,candles.length,"equity must be marked to market on every candle");
  assert.ok(body.equity_curve.every(point=>Number.isFinite(point.equity) && point.equity>0));
  assert.ok(body.warning.startsWith("Research only"));
});

test("EMA backtest accepts validated strategy periods and reports the selected parameters", async () => {
  const candles=[];
  for(let i=0;i<100;i++){
    const close=i<45?3100-i*2:i<75?3010+(i-45)*4:3130-(i-75)*3;
    candles.push({timestamp:new Date(Date.UTC(2025,0,1+i)).toISOString(),open:close,high:close+2,low:close-2,close});
  }
  const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({candles,fast_period:9,slow_period:21})
  }));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.fast_period,9);
  assert.equal(body.slow_period,21);
  assert.equal(body.strategy,"EMA9/EMA21 long-only crossover");
});

test("live comparison evaluates fixed EMA pairs across all supported real intervals", async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    const interval=new URL(String(url)).searchParams.get("interval");
    const intervalMs=({"15m":900000,"30m":1800000,"60m":3600000,"1d":86400000})[interval];
    const count=interval==="1d"?80:120;
    const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
    const candles=Array.from({length:count},(_,i)=>{
      const close=3100+(i<40?-i*1.5:i*0.7);
      return {timestamp:new Date(lastClosed-(count-1-i)*intervalMs).toISOString(),
        open:close-0.2,high:close+1,low:close-1,close};
    });
    return new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover/compare?symbol=xau"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(body.intervals.map(x=>x.interval),["15m","30m","60m","1d"]);
    assert.ok(body.intervals.every(x=>x.status==="LIVE"));
    assert.ok(body.intervals.every(x=>x.results.length===3));
    assert.deepEqual(body.strategies.map(x=>[x.fast_period,x.slow_period]),[[9,21],[12,26],[20,50]]);
    assert.equal(body.execution_enabled,undefined);
    assert.ok(body.warning.includes("do not predict future results"));
  }finally{globalThis.fetch=originalFetch;}
});

test("EMA backtest rejects arithmetic overflow instead of returning corrupt metrics", async () => {
  const candles = [];
  for (let i=0;i<80;i++) {
    const close = i<55 ? 1 : i<=56 ? 5 : 1e100;
    candles.push({
      timestamp:new Date(Date.UTC(2025,0,1+i)).toISOString(),
      open:close,high:close*1.001,low:close*0.99,close
    });
  }
  const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({candles,starting_capital:1e308})
  }));
  const body=await response.json();
  assert.equal(response.status,400);
  assert.match(body.error,/numeric range/i);
});

test("EMA backtest rejects incomplete or invalid OHLC input", async () => {
  const response=await worker.fetch(new Request("https://unit.test/v1/backtest/ema-crossover",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({candles:[]})
  }));
  assert.equal(response.status,400);
  assert.ok((await response.json()).error);
});

test("Telegram webhook rejects requests without the secret header", async () => {
  const response = await worker.fetch(new Request("https://unit.test/telegram/webhook", {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:{chat:{id:1},text:"/start"}})
  }), {BOT_TOKEN:"test-token",TELEGRAM_WEBHOOK_SECRET:"expected-secret"});
  assert.equal(response.status,401);
});

test("Telegram webhook reports missing configuration without exposing secrets", async () => {
  const response = await worker.fetch(new Request("https://unit.test/telegram/webhook", {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})
  }), {});
  assert.equal(response.status,503);
});


import { fetchTalasanj } from "./providers.js";

test("Talasanj provider maps only supported symbols with verified units and timestamps", async () => {
  const originalFetch = globalThis.fetch;
  const stamp = new Date().toISOString();
  let seenAuthorization = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://talasanj.info/api/v1/prices");
    seenAuthorization = options.headers.authorization === "Bearer test-only-key";
    return new Response(JSON.stringify({
      updated_at: stamp,
      prices: {
        gram18: { price: 7250000, updated_at: stamp },
        gram24: { price: 9660000, updated_at: stamp },
        mazaneh: { price: 31400000, updated_at: stamp },
        coin_full: { price: 81000000, updated_at: stamp },
        coin_half: { price: 43000000, updated_at: stamp },
        coin_quarter: { price: 26000000, updated_at: stamp },
        usd: { price: 71000, updated_at: stamp },
        ounce: { price: 2660, updated_at: stamp }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await fetchTalasanj({ TALASANJ_API_KEY: "test-only-key" });
    assert.equal(seenAuthorization, true);
    assert.equal(result.items.length, 8);
    assert.equal(result.items.find(x => x.id === "gold-18k").unit, "IRT");
    assert.equal(result.items.find(x => x.id === "xau").unit, "USD");
    assert.ok(result.items.every(x => x.price > 0 && x.updated_utc === stamp));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Talasanj provider fails closed when credentials or valid provider data are absent", async () => {
  assert.equal(await fetchTalasanj({}), null);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  try {
    assert.equal(await fetchTalasanj({ TALASANJ_API_KEY: "test-only-key" }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


function xausChartFixture(candles) {
  return {data_state:{status:"fresh",as_of:new Date().toISOString(),source:"upstream",age_seconds:1},
    points:candles.map(c=>({t:Math.floor(Date.parse(c.timestamp)/1000),
      o:c.open,h:c.high,l:c.low,c:c.close,v:null}))};
}

test("OHLC endpoint rejects missing XAUS freshness metadata", async () => {
  const intervalMs=3600000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:80},(_,i)=>{const close=2600+i*.1;return {timestamp:new Date(lastClosed-(79-i)*intervalMs).toISOString(),open:close,high:close+1,low:close-1,close};});
  const payload=xausChartFixture(candles);delete payload.data_state;
  globalThis.fetch=async()=>new Response(JSON.stringify(payload),{status:200});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();assert.equal(response.status,502);
    assert.match(body.error,/data state is missing/i);assert.equal(body.execution_enabled,false);
  } finally {globalThis.fetch=originalFetch;}
});

test("OHLC endpoint rejects stale XAUS freshness metadata even when candle timestamps look current", async () => {
  const intervalMs=3600000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:80},(_,i)=>{const close=2600+i*.1;return {timestamp:new Date(lastClosed-(79-i)*intervalMs).toISOString(),open:close,high:close+1,low:close-1,close};});
  const payload=xausChartFixture(candles);
  payload.data_state.as_of=new Date(Date.now()-10*60*1000).toISOString();
  payload.data_state.age_seconds=600;
  globalThis.fetch=async()=>new Response(JSON.stringify(payload),{status:200});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();assert.equal(response.status,502);
    assert.match(body.error,/freshness metadata.*stale/i);assert.equal(body.execution_enabled,false);
  } finally {globalThis.fetch=originalFetch;}
});

test("OHLC feed rejects duplicate completed candle timestamps", async () => {
  const intervalMs=3600000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:80},(_,i)=>{const close=2600+i*.1;return {timestamp:new Date(lastClosed-(79-i)*intervalMs).toISOString(),open:close,high:close+1,low:close-1,close};});
  candles[40]={...candles[39]};
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();assert.equal(response.status,502);assert.match(body.error,/duplicate candle timestamps/i);
  } finally {globalThis.fetch=originalFetch;}
});

test("OHLC endpoint reports missing intervals without fabricating candles", async () => {
  const intervalMs=3600000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:80},(_,i)=>{const close=2600+i*.1;return {timestamp:new Date(lastClosed-(79-i)*intervalMs).toISOString(),open:close,high:close+1,low:close-1,close};});
  candles.splice(35,1);
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();assert.equal(response.status,200);assert.equal(body.data_quality.status,"GAPS_DETECTED");
    assert.equal(body.data_quality.missing_intervals,1);assert.equal(body.candles.length,79);
  } finally {globalThis.fetch=originalFetch;}
});

test("global gold candle endpoint returns only completed validated OHLC candles", async () => {
  const originalFetch=globalThis.fetch;
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:80},(_,i)=>{
    const close=2600+i*0.2;
    return {timestamp:new Date(lastClosed-(79-i)*intervalMs).toISOString(),
      open:close-0.05,high:close+0.3,low:close-0.2,close};
  });
  let requested="";
  globalThis.fetch=async url=>{
    requested=String(url);
    return new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  };
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.match(requested,/xaus.com\/api\/v1\/chart\?symbol=xau/);
    assert.equal(body.provider,"XAUS");
    assert.equal(body.provider_symbol,"xau");
    assert.equal(body.status,"LIVE");
    assert.equal(body.candles.length,80);
    assert.equal(body.candles.at(-1).timestamp,candles.at(-1).timestamp);
    assert.equal(body.candles.at(-1).close,candles.at(-1).close);
  } finally { globalThis.fetch=originalFetch; }
});

test("global gold candle endpoint rejects timestamps misaligned to declared interval", async () => {
  const originalFetch=globalThis.fetch;
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:80},(_,i)=>{
    const close=2600+i;
    return {timestamp:new Date(lastClosed-(79-i)*intervalMs+(i===79?1000:0)).toISOString(),
      open:close,high:close+1,low:close-1,close};
  });
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  try{
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,502);
    assert.equal(body.status,"UNAVAILABLE");
    assert.deepEqual(body.candles,[]);
    assert.match(body.error,/not aligned/i);
  }finally{globalThis.fetch=originalFetch;}
});

test("global gold candle endpoint rejects stale upstream OHLC data", async () => {
  const originalFetch=globalThis.fetch;
  const old=Date.now()-24*3600000;
  const candles=Array.from({length:80},(_,i)=>{
    const close=2600+i;
    return {timestamp:new Date(old-(79-i)*3600000).toISOString(),open:close,high:close+1,low:close-1,close};
  });
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,502);
    assert.equal(body.status,"UNAVAILABLE");
    assert.deepEqual(body.candles,[]);
  } finally { globalThis.fetch=originalFetch; }
});

test("latest signal endpoint evaluates real provider OHLC and never enables execution", async () => {
  const originalFetch=globalThis.fetch;
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  let close=2600;
  const candles=Array.from({length:120},(_,i)=>{
    const previous=close;
    close+=i%2===0?0.5:-0.3;
    if(i===119) close=previous+0.5;
    return {timestamp:new Date(lastClosed-(119-i)*intervalMs).toISOString(),
      open:previous,high:Math.max(previous,close)+0.2,low:Math.min(previous,close)-0.2,close};
  });
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/latest?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.market_data_status,"LIVE");
    assert.equal(body.market_provider,"XAUS");
    assert.equal(body.market_provider_symbol,"xau");
    assert.equal(body.signal,"BUY");
    assert.equal(body.signal_quality.status,"TRADEABLE");
    assert.equal(body.signal_quality.blocked_by_regime,false);
    assert.equal(body.market_regime.tradeable,true);
    assert.equal(body.execution_enabled,false);
    assert.equal(body.risk_reward_ratio,2);
  } finally { globalThis.fetch=originalFetch; }
});

test("latest signal endpoint fails closed when the provider is unavailable", async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response("provider down",{status:503});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/latest?symbol=xau&interval=60m"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.signal,"NO_TRADE");
    assert.equal(body.data_status,"UNAVAILABLE");
    assert.equal(body.execution_enabled,false);
  } finally { globalThis.fetch=originalFetch; }
});


test("multi-timeframe endpoint requires 15m, 60m and daily trend alignment", async () => {
  const originalFetch=globalThis.fetch;
  const candlesByInterval={};
  for (const [interval,intervalMs,count] of [["15m",900000,120],["60m",3600000,120],["1d",86400000,80]]) {
    const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
    let close=2600;
    candlesByInterval[interval]=Array.from({length:count},(_,i)=>{
      const previous=close;
      close+=i%2===0?0.5:-0.3;
      if(i===count-1) close=previous+0.5;
      return {timestamp:new Date(lastClosed-(count-1-i)*intervalMs).toISOString(),
        open:previous,high:Math.max(previous,close)+0.2,
        low:Math.min(previous,close)-0.2,close};
    });
  }
  globalThis.fetch=async url=>{
    const interval=new URL(String(url)).searchParams.get("interval");
    return new Response(JSON.stringify(xausChartFixture(candlesByInterval[interval]||[])),
      {status:200,headers:{"content-type":"application/json"}});
  };
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/multi-timeframe?symbol=xau"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.market_data_status,"LIVE");
    assert.equal(body.market_provider,"XAUS");
    assert.equal(body.timeframes["15m"].signal,"BUY");
    assert.equal(body.timeframes["60m"].signal,"BUY");
    assert.equal(body.timeframes["1d"].trend,"BULLISH");
    assert.equal(body.timeframes["15m"].proposed_signal,"BUY");
    assert.equal(body.timeframes["60m"].signal_quality.regime_tradeable,true);
    assert.equal(body.signal,"BUY");
    assert.equal(body.signal_quality.status,"PASSED");
    assert.equal(body.signal_quality.passed_checks,5);
    assert.equal(body.signal_quality.required_checks,5);
    assert.deepEqual(body.signal_quality.blocked_reasons,[]);
    assert.equal(body.execution_enabled,false);
    assert.equal(body.risk_reward_ratio,2);
  } finally { globalThis.fetch=originalFetch; }
});

test("multi-timeframe endpoint blocks signals when any timeframe has candle gaps", async () => {
  const originalFetch=globalThis.fetch;
  const candlesByInterval={};
  for(const [interval,intervalMs,count] of [["15m",900000,120],["60m",3600000,120],["1d",86400000,80]]){
    const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
    let close=2600;
    candlesByInterval[interval]=Array.from({length:count},(_,i)=>{
      const previous=close;close+=i%2===0?0.5:-0.3;if(i===count-1)close=previous+0.5;
      const historicalOffset=i<60?1:0;
      return {timestamp:new Date(lastClosed-(count-1-i+historicalOffset)*intervalMs).toISOString(),
        open:previous,high:Math.max(previous,close)+0.2,low:Math.min(previous,close)-0.2,close};
    });
  }
  globalThis.fetch=async url=>{
    const interval=new URL(String(url)).searchParams.get("interval");
    return new Response(JSON.stringify(xausChartFixture(candlesByInterval[interval]||[])),
      {status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/multi-timeframe?symbol=xau"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.signal,"NO_TRADE");
    assert.equal(body.market_data_status,"DEGRADED");
    assert.equal(body.timeframes["15m"].data_status,"GAPPED");
    assert.equal(body.signal_quality.status,"BLOCKED");
    assert.equal(body.signal_quality.checks.find(x=>x.id==="all_timeframe_data_quality").passed,false);
    assert.ok(body.signal_quality.blocked_reasons.some(x=>/candle gaps/i.test(x)));
    assert.equal(body.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("multi-timeframe signal is archived once per completed 60m candle and history is retrievable", async () => {
  const originalFetch=globalThis.fetch;
  const store=new Map();
  const kv={
    async put(key,value,options){store.set(key,{value:JSON.parse(value),options});},
    async list({prefix,limit}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name}))};},
    async get(key,type){const item=store.get(key);return item?item.value:null;}
  };
  const candlesByInterval={};
  for(const [interval,intervalMs,count] of [["15m",900000,120],["60m",3600000,120],["1d",86400000,80]]){
    const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
    let close=2600;
    candlesByInterval[interval]=Array.from({length:count},(_,i)=>{
      const previous=close;close+=i%2===0?0.5:-0.3;if(i===count-1)close=previous+0.5;
      return {timestamp:new Date(lastClosed-(count-1-i)*intervalMs).toISOString(),
        open:previous,high:Math.max(previous,close)+0.2,low:Math.min(previous,close)-0.2,close};
    });
  }
  globalThis.fetch=async url=>{
    const interval=new URL(String(url)).searchParams.get("interval");
    return new Response(JSON.stringify(xausChartFixture(candlesByInterval[interval]||[])),
      {status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const env={SIGNAL_HISTORY:kv};
    const signal=await worker.fetch(new Request("https://unit.test/v1/signals/multi-timeframe?symbol=xau"),env);
    const signalBody=await signal.json();
    assert.equal(signalBody.market_data_status,"LIVE");
    assert.equal(store.size,1);
    const saved=[...store.values()][0];
    assert.equal(saved.value.signal,signalBody.signal);
    assert.equal(saved.options.expirationTtl,90*24*60*60);
    const history=await worker.fetch(new Request("https://unit.test/v1/signals/history?limit=20"),env);
    const historyBody=await history.json();
    assert.equal(history.status,200);
    assert.equal(historyBody.count,1);
    assert.equal(historyBody.records[0].archive_source,"XAUS completed OHLC multi-timeframe evaluation");
    assert.equal(historyBody.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("signal performance uses next candle open, completed horizons and refuses candle gaps", async () => {
  const originalFetch=globalThis.fetch;
  const store=new Map();
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:40},(_,i)=>{
    const open=2600+i;
    return {timestamp:new Date(lastClosed-(39-i)*intervalMs).toISOString(),
      open,high:open+2,low:open-1,close:open+1};
  });
  const signalTime=candles[10].timestamp;
  // Equivalent UTC offset notation must match the same candle timestamp.
  const signalTimeWithOffset=signalTime.replace("Z","+00:00");
  store.set("xau:latest:sample",{signal:"BUY",symbol:"xau",confidence:80,entry:2610,stop_loss:2600,take_profit:2630,
    market_data_status:"LIVE",execution_enabled:false,
    archive_source:"XAUS completed OHLC multi-timeframe evaluation",
    last_candle_at:signalTimeWithOffset,recorded_at:new Date(Date.parse(signalTime)+1000).toISOString()});
  const kv={async list({prefix,limit}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name}))};},
    async get(key){return store.get(key)||null;}};
  globalThis.fetch=async url=>new Response(JSON.stringify(xausChartFixture(candles)),
    {status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/performance"),{SIGNAL_HISTORY:kv});
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.directional_signals,1);
    assert.equal(body.horizons.find(x=>x.horizon_candles===1).scored,1);
    assert.equal(body.horizons.find(x=>x.horizon_candles===4).scored,1);
    assert.equal(body.horizons.find(x=>x.horizon_candles===24).scored,1);
    assert.equal(body.outcomes[0].outcomes[1].entry_price,candles[11].open);
    assert.equal(body.outcomes[0].outcomes[1].entry_basis,"next_completed_candle_open");
    assert.equal(body.execution_enabled,false);
    assert.equal(body.sample_quality.minimum_context_samples,30);
    assert.equal(body.sample_quality.maximum_scored_samples,1);
    assert.equal(body.sample_quality.status,"BELOW_CONTEXT_THRESHOLD");
    assert.match(body.warning,/not evidence of future profitability/);
    const gapCandles=candles.filter((_,i)=>i!==11);
    globalThis.fetch=async url=>new Response(JSON.stringify(xausChartFixture(gapCandles)),
      {status:200,headers:{"content-type":"application/json"}});
    const gapResponse=await worker.fetch(new Request("https://unit.test/v1/signals/performance"),{SIGNAL_HISTORY:kv});
    const gapBody=await gapResponse.json();
    assert.equal(gapResponse.status,200);
    assert.equal(gapBody.outcomes[0].outcomes[1].status,"DATA_GAP");
    assert.equal(gapBody.horizons.find(x=>x.horizon_candles===1).scored,0);
    assert.equal(gapBody.horizons.find(x=>x.horizon_candles===4).scored,0);
  } finally { globalThis.fetch=originalFetch; }
});

test("signal history and performance ignore malformed or execution-enabled archived records", async () => {
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:40},(_,i)=>{
    const open=2600+i;
    return {timestamp:new Date(lastClosed-(39-i)*intervalMs).toISOString(),
      open,high:open+2,low:open-1,close:open+1};
  });
  const valid={signal:"BUY",symbol:"xau",confidence:80,entry:2610,stop_loss:2600,take_profit:2630,
    market_data_status:"LIVE",execution_enabled:false,
    archive_source:"XAUS completed OHLC multi-timeframe evaluation",
    last_candle_at:candles[10].timestamp,recorded_at:new Date(Date.parse(candles[10].timestamp)+1000).toISOString()};
  const store=new Map([
    ["xau:latest:valid",valid],
    ["xau:latest:forged",{...valid,execution_enabled:true}],
    ["xau:latest:bad-price",{...valid,entry:NaN}],
    ["xau:latest:bad-source",{...valid,archive_source:"untrusted"}]
  ]);
  const kv={async list({prefix,limit}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name}))};},
    async get(key){return store.get(key)||null;}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),
    {status:200,headers:{"content-type":"application/json"}});
  try{
    const env={SIGNAL_HISTORY:kv};
    const history=await worker.fetch(new Request("https://unit.test/v1/signals/history?limit=20"),env);
    const historyBody=await history.json();
    assert.equal(historyBody.count,1);
    assert.equal(historyBody.records[0].signal,"BUY");
    const performance=await worker.fetch(new Request("https://unit.test/v1/signals/performance"),env);
    const performanceBody=await performance.json();
    assert.equal(performanceBody.directional_signals,1);
    assert.equal(performanceBody.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("signal performance returns unavailable without storage or when the candle provider fails", async () => {
  const noStorage=await worker.fetch(new Request("https://unit.test/v1/signals/performance"));
  assert.equal(noStorage.status,503);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response("provider down",{status:503});
  try {
    const kv={async list(){return {keys:[]};},async get(){return null;}};
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/performance"),{SIGNAL_HISTORY:kv});
    assert.equal(response.status,502);
    assert.equal((await response.json()).execution_enabled,false);
  } finally { globalThis.fetch=originalFetch; }
});

test("Telegram signal alert is sent once for a new confirmed direction and not duplicated", async () => {
  const originalFetch=globalThis.fetch;
  const store=new Map();
  const kv={
    async put(key,value){store.set(key,JSON.parse(value));},
    async list({prefix,limit}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(name=>({name}))};},
    async get(key){return store.get(key)||null;}
  };
  const candlesByInterval={};
  for(const [interval,intervalMs,count] of [["15m",900000,120],["60m",3600000,120],["1d",86400000,80]]){
    const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
    let close=2600;
    candlesByInterval[interval]=Array.from({length:count},(_,i)=>{
      const previous=close;close+=i%2===0?0.5:-0.3;if(i===count-1)close=previous+0.5;
      return {timestamp:new Date(lastClosed-(count-1-i)*intervalMs).toISOString(),
        open:previous,high:Math.max(previous,close)+0.2,low:Math.min(previous,close)-0.2,close};
    });
  }
  const sent=[];
  globalThis.fetch=async url=>{
    const target=String(url);
    if(target.includes("api.telegram.org")){
      sent.push(target);
      return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200,headers:{"content-type":"application/json"}});
    }
    const interval=new URL(target).searchParams.get("interval");
    return new Response(JSON.stringify(xausChartFixture(candlesByInterval[interval]||[])),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const env={SIGNAL_HISTORY:kv,BOT_TOKEN:"test-token",SIGNAL_ALERT_CHAT_ID:"12345"};
    const request=()=>new Request("https://unit.test/v1/signals/multi-timeframe?symbol=xau");
    const first=await worker.fetch(request(),env);
    const firstBody=await first.json();
    assert.equal(firstBody.signal,"BUY");
    assert.equal(firstBody.alert_status,"SENT");
    assert.equal(sent.length,1);
    const second=await worker.fetch(request(),env);
    const secondBody=await second.json();
    assert.equal(secondBody.signal,"BUY");
    assert.equal(sent.length,1,"same completed candle must not send duplicate Telegram alerts");
  }finally{globalThis.fetch=originalFetch;}
});

test("Telegram /signals command returns the latest archived signal", async () => {
  const originalFetch=globalThis.fetch;
  const store=new Map([["xau:latest:0000000000001",{signal:"BUY",confidence:80,trend:"BULLISH",
    recorded_at:"2026-11-24T12:00:00.000Z",entry:2650,stop_loss:2600,take_profit:2750}]]);
  const kv={async list({prefix,limit}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name}))};},
    async get(key){return store.get(key)||null;}};
  let telegramBody=null;
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes("api.telegram.org")){telegramBody=JSON.parse(options.body);return new Response(JSON.stringify({ok:true}),{status:200});}
    throw new Error("Unexpected external request");
  };
  try{
    const env={BOT_TOKEN:"test-token",TELEGRAM_WEBHOOK_SECRET:"test-secret",SIGNAL_HISTORY:kv};
    const response=await worker.fetch(new Request("https://unit.test/telegram/webhook",{
      method:"POST",headers:{"content-type":"application/json","X-Telegram-Bot-Api-Secret-Token":"test-secret"},
      body:JSON.stringify({message:{chat:{id:77},text:"/signals"}})
    }),env);
    assert.equal(response.status,200);
    assert.match(telegramBody.text,/خرید/);
    assert.match(telegramBody.text,/ورود: 2650/);
  }finally{globalThis.fetch=originalFetch;}
});

test("multi-timeframe endpoint fails closed if any timeframe is unavailable", async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    const interval=new URL(String(url)).searchParams.get("interval");
    if(interval==="15m") return new Response("upstream down",{status:503});
    const intervalMs=interval==="1d"?86400000:3600000;
    const count=80,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
    const candles=Array.from({length:count},(_,i)=>{
      const close=2600+i*0.2;
      return {timestamp:new Date(lastClosed-(count-1-i)*intervalMs).toISOString(),
        open:close-0.1,high:close+0.2,low:close-0.2,close};
    });
    return new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  };
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/multi-timeframe?symbol=xau"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.signal,"NO_TRADE");
    assert.equal(body.data_status,"UNAVAILABLE");
    assert.equal(body.execution_enabled,false);
  } finally { globalThis.fetch=originalFetch; }
});


test("position sizing rounds down to broker lot step and stays within risk budget", async () => {
  const response=await worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({equity:100000,entry:2000,stop_loss:1990,
      contract_value_per_price_unit:100,lot_step:0.3,min_lot:0.3,max_lot:5})
  }));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.allowed,true);
  assert.equal(body.lots,0.9);
  assert.ok(body.estimated_loss_at_stop<=body.risk_amount);
  assert.equal(body.lot_step,0.3);
});

test("position sizing blocks a size below broker minimum after rounding", async () => {
  const response=await worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({equity:10000,entry:2000,stop_loss:1990,
      contract_value_per_price_unit:100,lot_step:0.1,min_lot:0.2,max_lot:5})
  }));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.allowed,false);
  assert.equal(body.lots,0);
  assert.match(body.reason,/below the broker minimum/i);
});

test("position sizing rejects invalid broker lot constraints", async () => {
  const response=await worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({equity:100000,entry:2000,stop_loss:1990,
      contract_value_per_price_unit:100,lot_step:0,min_lot:0.01})
  }));
  assert.equal(response.status,400);
});


test("walk-forward backtest selects parameters on past data and evaluates later unseen folds", async () => {
  const candles=Array.from({length:240},(_,i)=>{
    const close=2500+i*0.35+Math.sin(i/4)*3+Math.sin(i/11)*1.5;
    const previous=i?2500+(i-1)*0.35+Math.sin((i-1)/4)*3+Math.sin((i-1)/11)*1.5:close-0.2;
    return {timestamp:new Date(Date.UTC(2026,0,1)+i*3600000).toISOString(),
      open:previous,high:Math.max(previous,close)+0.8,low:Math.min(previous,close)-0.8,close};
  });
  const response=await worker.fetch(new Request("https://unit.test/v1/backtest/walk-forward",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({candles,starting_capital:10000,fee_bps:10,slippage_bps:5})
  }));
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.fold_count,3);
  assert.equal(body.folds.length,3);
  assert.equal(body.execution_enabled,false);
  for(const fold of body.folds){
    assert.ok(Date.parse(fold.test_start)>Date.parse(fold.training_end));
    assert.ok(["EMA9/EMA21","EMA12/EMA26","EMA20/EMA50"].includes(fold.selected_strategy));
    assert.ok(Number.isFinite(fold.out_of_sample_return_pct));
  }
});

test("walk-forward backtest rejects short history instead of reporting misleading results", async () => {
  const candles=Array.from({length:120},(_,i)=>{
    const close=2500+i*0.2;
    return {timestamp:new Date(Date.UTC(2026,0,1)+i*3600000).toISOString(),
      open:close-0.1,high:close+0.3,low:close-0.3,close};
  });
  const response=await worker.fetch(new Request("https://unit.test/v1/backtest/walk-forward",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({candles})
  }));
  const body=await response.json();
  assert.equal(response.status,400);
  assert.match(body.error,/180 to 5000/i);
});

test("market regime identifies trend and blocks range and high volatility", async () => {
  const make=(mode)=>{let close=2500;const lastClosed=Math.floor(Date.now()/3600000)*3600000-3600000;return Array.from({length:120},(_,i)=>{const prev=close;close+=mode==="trend"?0.9:mode==="range"?(i%2===0?0.12:-0.12):(i%2===0?25:-25);return {timestamp:new Date(lastClosed-(119-i)*3600000).toISOString(),open:prev,high:Math.max(prev,close)+(mode==="volatile"?10:0.2),low:Math.min(prev,close)-(mode==="volatile"?10:0.2),close};});};
  const original=globalThis.fetch;let mode="trend";
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(make(mode))),{status:200,headers:{"content-type":"application/json"}});
  try { const get=async()=>(await worker.fetch(new Request("https://unit.test/v1/market/regime?symbol=xau&interval=60m"))).json();
    let body=await get();assert.equal(body.status,"TRENDING");assert.equal(body.tradeable,true);
    mode="range";body=await get();assert.equal(body.status,"RANGE");assert.equal(body.tradeable,false);
    mode="volatile";body=await get();assert.equal(body.status,"HIGH_VOLATILITY");assert.equal(body.tradeable,false);assert.equal(body.execution_enabled,false);
  } finally {globalThis.fetch=original;}
});
test("portfolio risk guard never authorizes manually supplied account figures",async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/risk/portfolio-check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({equity:100000,day_start_equity:100000,peak_equity:105000,proposed_risk_fraction:0.01,open_positions:[{risk_amount:500}],max_open_risk_fraction:0.02,max_positions:3})}));
 const body=await response.json();assert.equal(response.status,200);assert.equal(body.allowed,false);assert.equal(body.status,"UNVERIFIED_ACCOUNT_DATA");assert.equal(body.data_verified,false);assert.equal(body.aggregate_risk_amount,1500);assert.equal(body.execution_enabled,false);
});
test("portfolio risk guard blocks daily loss and peak drawdown",async()=>{
 const call=async payload=>(await worker.fetch(new Request("https://unit.test/v1/risk/portfolio-check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}))).json();
 const base={equity:97000,day_start_equity:100000,peak_equity:110000,open_positions:[]};
 const daily=await call(base);assert.equal(daily.allowed,false);assert.match(daily.reason,/Daily loss limit/);
 const dd=await call({...base,equity:101000,day_start_equity:101000});assert.equal(dd.allowed,false);assert.match(dd.reason,/drawdown limit/);
});
test("portfolio risk guard blocks excessive aggregate risk and concurrent positions",async()=>{
 const call=async payload=>(await worker.fetch(new Request("https://unit.test/v1/risk/portfolio-check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}))).json();
 const base={equity:100000,day_start_equity:100000,peak_equity:100000,proposed_risk_fraction:0.01};
 const exposure=await call({...base,open_positions:[{risk_amount:1500}]});assert.equal(exposure.allowed,false);assert.match(exposure.reason,/aggregate open plus proposed risk/i);
 const count=await call({...base,open_positions:[{risk_amount:100},{risk_amount:100},{risk_amount:100}]});assert.equal(count.allowed,false);assert.match(count.reason,/concurrent positions/i);
});
test("portfolio risk guard rejects proposed risk above the hard limit",async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/risk/portfolio-check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({equity:100000,day_start_equity:100000,peak_equity:100000,proposed_risk_fraction:0.05})}));assert.equal(response.status,400);
});


test("SELL signal performance reports non-negative favorable and adverse excursions", async () => {
  const originalFetch=globalThis.fetch;
  const store=new Map();
  const intervalMs=3600000;
  const lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:40},(_,i)=>{
    const open=2600+i;
    return {timestamp:new Date(lastClosed-(39-i)*intervalMs).toISOString(),
      open,high:open+2,low:i===11?open:open-1,close:open+1};
  });
  store.set("xau:latest:sell-sample",{signal:"SELL",symbol:"xau",confidence:80,entry:2610,stop_loss:2620,take_profit:2590,
    market_data_status:"LIVE",execution_enabled:false,
    archive_source:"XAUS completed OHLC multi-timeframe evaluation",
    last_candle_at:candles[10].timestamp,recorded_at:new Date(Date.parse(candles[10].timestamp)+1000).toISOString()});
  const kv={async list({prefix,limit}){return {keys:[...store.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name}))};},
    async get(key){return store.get(key)||null;}};
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),
    {status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/signals/performance"),{SIGNAL_HISTORY:kv});
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    const outcome=body.outcomes[0].outcomes[1];
    assert.equal(outcome.status,"SCORED");
    assert.ok(outcome.return_pct<0,"rising prices should be adverse for a SELL signal");
    assert.equal(outcome.max_favorable_pct,0,"a favorable excursion must never be negative");
    assert.ok(outcome.max_adverse_pct>0,"the rising market should create adverse excursion");
    assert.equal(body.execution_enabled,false);
  } finally { globalThis.fetch=originalFetch; }
});


test("API responses include baseline browser security headers", async () => {
  const response=await worker.fetch(new Request("https://unit.test/health"));
  assert.equal(response.headers.get("x-content-type-options"),"nosniff");
  assert.equal(response.headers.get("x-frame-options"),"DENY");
  assert.equal(response.headers.get("referrer-policy"),"no-referrer");
  assert.equal(response.headers.get("permissions-policy"),"camera=(), microphone=(), geolocation=()");
  assert.equal(response.headers.get("cache-control"),"no-store");
});

test("CORS preflight advertises only the API methods and content type header", async () => {
  const response=await worker.fetch(new Request("https://unit.test/health",{
    method:"OPTIONS",headers:{origin:"https://example.test","access-control-request-method":"POST"}
  }));
  assert.equal(response.status,200);
  assert.equal(response.headers.get("access-control-allow-methods"),"GET,POST,OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"),"content-type,authorization");
  assert.equal(response.headers.get("access-control-max-age"),"86400");
  assert.equal(response.headers.get("x-frame-options"),"DENY");
});


test("Talasanj rejects boolean, string, non-finite and non-positive prices", async () => {
  const originalFetch=globalThis.fetch;
  const stamp=new Date().toISOString();
  globalThis.fetch=async()=>new Response(JSON.stringify({updated_at:stamp,prices:{
    gram18:{price:true,updated_at:stamp},gram24:{price:"9660000",updated_at:stamp},
    mazaneh:{price:0,updated_at:stamp},coin_full:{price:Infinity,updated_at:stamp}
  }}),{status:200,headers:{"content-type":"application/json"}});
  try {
    const result=await fetchTalasanj({TALASANJ_API_KEY:"test-only-key"});
    assert.equal(result,null,"provider with no valid quotes must allow fallback");
  } finally {globalThis.fetch=originalFetch;}
});

test("Talasanj rejects stale or malformed per-symbol timestamps", async () => {
  const originalFetch=globalThis.fetch;
  const old=new Date(Date.now()-120000).toISOString();
  globalThis.fetch=async()=>new Response(JSON.stringify({updated_at:new Date().toISOString(),prices:{
    gram18:{price:7250000,updated_at:old},gram24:{price:9660000,updated_at:"not-a-date"}
  }}),{status:200,headers:{"content-type":"application/json"}});
  try {
    assert.equal(await fetchTalasanj({TALASANJ_API_KEY:"test-only-key"}),null);
  } finally {globalThis.fetch=originalFetch;}
});


test("portfolio risk guard rejects overflow in open exposure aggregation", async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/risk/portfolio-check",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({equity:1e308,day_start_equity:1e308,peak_equity:1e308,
   proposed_risk_fraction:0.01,max_open_risk_fraction:0.02,
   open_positions:[{risk_amount:1e308},{risk_amount:1e308}]})
 }));
 assert.equal(response.status,400);
 assert.match((await response.json()).error,/overflow/i);
});


test("position sizing rejects string and boolean numeric inputs", async()=>{
 const call=async payload=>worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}));
 const base={equity:100000,entry:2000,stop_loss:1990,contract_value_per_price_unit:100};
 for(const payload of [{...base,equity:"100000"},{...base,entry:true},{...base,lot_step:"0.1"}]){
  const response=await call(payload);assert.equal(response.status,400);
 }
});

test("position sizing rounds down to broker maximum and valid lot step", async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({equity:100000,entry:2000,stop_loss:1990,
   contract_value_per_price_unit:100,lot_step:0.1,min_lot:0.1,max_lot:0.75})
 }));
 const body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body));
 assert.equal(body.allowed,true);
 assert.equal(body.lots,0.7);
 assert.ok(body.estimated_loss_at_stop<=body.risk_amount);
});

test("position sizing rejects broker minimum lot not aligned to step", async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/risk/position-size",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({equity:100000,entry:2000,stop_loss:1990,
   contract_value_per_price_unit:100,lot_step:0.1,min_lot:0.15,max_lot:1})
 }));
 assert.equal(response.status,400);
});


function paperFixture(){
 return Array.from({length:100},(_,i)=>{
  const close=i<30?3000-i*2:2940+(i-30)*4;
  return {timestamp:new Date(Date.now()-(99-i)*3600000).toISOString(),
   open:close-0.2,high:close+1,low:close-1,close};
 });
}

test("historical backtest fetches only verified completed XAUS candles and stays paper-only",async()=>{
 const originalFetch=globalThis.fetch;
 const intervalMs=3600000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
 const candles=Array.from({length:100},(_,i)=>{
  const close=i<30?3000-i*2:2940+(i-30)*4;
  return {timestamp:new Date(lastClosed-(99-i)*intervalMs).toISOString(),
   open:close-.2,high:close+1,low:close-1,close};
 });
 globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
 try{
  const response=await worker.fetch(new Request("https://unit.test/v1/paper-trading/backtest",{
   method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({symbol:"xau",interval:"60m",fast_period:3,slow_period:8,
    starting_capital:10000,risk_fraction:.01,contract_value_per_price_unit:1,fee_bps:2,slippage_bps:1})
  }));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.mode,"PAPER_ONLY");assert.equal(body.execution_enabled,false);
  assert.equal(body.provider,"XAUS");assert.equal(body.symbol,"xau");
  assert.ok(body.candles===undefined);
  assert.ok(body.closed_trades>=0);assert.ok(body.data_quality.candle_count>=60);
  assert.match(body.history_note,/not a multi-year/i);
 }finally{globalThis.fetch=originalFetch;}
});

test("historical backtest rejects unsupported domestic instruments without fabricating data",async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/paper-trading/backtest",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({symbol:"gold-18k",interval:"60m",contract_value_per_price_unit:1})
 }));
 assert.equal(response.status,400);
});

test("paper trading simulation returns a trade journal and virtual equity without execution",async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/paper-trading/simulate",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({candles:paperFixture(),fast_period:3,slow_period:8,
   starting_capital:10000,risk_fraction:0.01,contract_value_per_price_unit:1,
   fee_bps:2,slippage_bps:1})
 }));
 const body=await response.json();
 assert.equal(response.status,200,JSON.stringify(body));
 assert.equal(body.mode,"PAPER_ONLY");
 assert.equal(body.execution_enabled,false);
 assert.equal(body.persistent_account,false);
 assert.equal(body.starting_capital,10000);
 assert.ok(Array.isArray(body.trades));
 assert.ok(Array.isArray(body.equity_curve));
 assert.ok(body.final_equity>0);
 assert.ok(body.trades.length>0,JSON.stringify(body));
 assert.ok(body.trades.every(t=>Number.isFinite(t.net_pnl)&&t.exit_reason));
});

test("paper trading simulation rejects malformed and nonnumeric configuration",async()=>{
 const call=payload=>worker.fetch(new Request("https://unit.test/v1/paper-trading/simulate",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}));
 const base={candles:paperFixture(),fast_period:3,slow_period:8,
  starting_capital:10000,risk_fraction:0.01,contract_value_per_price_unit:1};
 const stringInput=await call({...base,starting_capital:"10000"});
 assert.equal(stringInput.status,400);
 const noContract=await call({...base,contract_value_per_price_unit:undefined});
 assert.equal(noContract.status,400);
 const duplicate=paperFixture();duplicate[40]=duplicate[39];
 const badCandles=await call({...base,candles:duplicate});
 assert.equal(badCandles.status,400);
});

test("paper trade journal reports bounded risk, fees and supported exit reasons",async()=>{
 const response=await worker.fetch(new Request("https://unit.test/v1/paper-trading/simulate",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({candles:paperFixture(),fast_period:3,slow_period:8,
   starting_capital:10000,risk_fraction:0.01,contract_value_per_price_unit:1,
   fee_bps:2,slippage_bps:1})
 }));
 const body=await response.json();
 assert.equal(response.status,200);
 assert.equal(body.execution_enabled,false);
 assert.deepEqual(body.cost_model,{fee_bps_per_side:2,slippage_bps_per_side:1});
 assert.ok(body.trades.every(t=>t.quantity>0&&Number.isFinite(t.fees)&&
  ["STOP_LOSS","STOP_GAP","TAKE_PROFIT","TAKE_PROFIT_GAP"].includes(t.exit_reason)));
});


function paperAccountEnv({allow=true,integrityOverride=null,createTradeError=null}={}) {
  const accounts=new Map();
  const registeredIds=new Set();
  return {
    __accounts:accounts,
    PAPER_ACCOUNTS:{
      getByName(name) {
        if(name==="__paper_bootstrap_guard__") return {
          allowCreation:async()=>allow,
          registerAccount:async(accountId)=>{registeredIds.add(accountId);return {registered:true};},
          listAccountIds:async()=>[...registeredIds]
        };
        return {
          createAccount:async(accountId,tokenHash,currency,capital,createdAt)=>{
            accounts.set(accountId,{tokenHash,currency,capital,createdAt});
            return {account_id:accountId,currency,starting_capital:capital,
              balance:capital,created_at:createdAt,trading_enabled:false};
          },
          getSummary:async(tokenHash)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            return {account_id:name,currency:a.currency,starting_capital:a.capital,
              balance:a.capital,realized_pnl:0,total_trades:0,open_trades:0,
              closed_trades:0,ledger_events:0,created_at:a.createdAt,
              trading_enabled:false,execution_enabled:false};
          },
          getIntegrityReport:async(tokenHash)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            if(integrityOverride)return {...integrityOverride,account_id:name};
            return {account_id:name,currency:a.currency,integrity_status:"PARTIAL",
              integrity_note:"Ledger entries are not yet emitted by the paper-trading lifecycle.",
              discrepancy_count:0,discrepancies:[],starting_capital:a.capital,
              derived_balance:a.capital,ledger:{events:0,net_change:0,mode:"EMPTY",status:"NOT_IMPLEMENTED"},
              trades:{total:0,open:0,closed:0,realized_pnl:0,open_fees:0},
              mode:"PAPER_ONLY",execution_enabled:false};
          },
          createTrade:async(tokenHash,trade,createdAt)=>{
            if(createTradeError) throw new Error(createTradeError);
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            a.trades??=[];
            if(trade.idempotency_key){
              const existing=a.trades.find(t=>t.idempotency_key===trade.idempotency_key);
              if(existing)return {...existing,duplicate:true};
            }
            if(a.trades.some(t=>t.status==="OPEN"&&t.symbol===trade.symbol))throw new Error("An open paper trade already exists for this symbol. Close it before opening another.");
            const row={...trade,status:"OPEN",opened_at:createdAt,fees:trade.quantity*trade.entry_price*trade.fee_bps/10000};
            a.trades.push(row);
            return row;
          },
          closeTrade:async(tokenHash,tradeId,exitPrice,feeBps,closedAt)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            const trade=(a.trades??[]).find(t=>t.trade_id===tradeId&&t.status==="OPEN");
            if(!trade)return {error:"TRADE_NOT_OPEN"};
            const gross=(exitPrice-trade.entry_price)*trade.quantity*(trade.side==="BUY"?1:-1);
            const fees=(trade.entry_price+exitPrice)*trade.quantity*feeBps/10000;
            Object.assign(trade,{status:"CLOSED",closed_at:closedAt,exit_price:exitPrice,fees,realized_pnl:gross-fees});
            a.notifications??=[];
            a.notifications.unshift({notification_id:"closed:"+tradeId,event_type:"TRADE_CLOSED",trade_id:tradeId,
              title:"موقعیت آزمایشی بسته شد",message:trade.symbol+" • سود/زیان: "+(gross-fees).toFixed(2),
              realized_pnl:gross-fees,created_at:closedAt,metadata:{}});
            return {trade_id:tradeId,status:"CLOSED",exit_price:exitPrice,realized_pnl:gross-fees,fees,closed_at:closedAt};
          },
          monitorTrades:async(tokenHash,symbol,candle,feeBps,checkedAt)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            a.trades??=[];
            const results=[];
            for(const trade of a.trades.filter(t=>t.status==="OPEN"&&t.symbol===symbol)){
              if(trade.last_checked_at&&trade.last_checked_at>=candle.timestamp){results.push({trade_id:trade.trade_id,status:"UNCHANGED"});continue;}
              const buy=trade.side==="BUY",stopHit=buy?candle.low<=trade.stop_loss:candle.high>=trade.stop_loss;
              const targetHit=buy?candle.high>=trade.take_profit:candle.low<=trade.take_profit;
              let exit=null,reason=null;
              if(stopHit){reason="STOP_LOSS";exit=buy&&candle.open<trade.stop_loss?candle.open:!buy&&candle.open>trade.stop_loss?candle.open:trade.stop_loss;}
              else if(targetHit){reason="TAKE_PROFIT";exit=trade.take_profit;}
              trade.last_checked_at=candle.timestamp;
              if(exit!==null){
                const gross=(exit-trade.entry_price)*trade.quantity*(buy?1:-1);
                const exitFee=exit*trade.quantity*feeBps/10000,fees=trade.fees+exitFee;
                Object.assign(trade,{status:"CLOSED",closed_at:checkedAt,exit_price:exit,fees,realized_pnl:gross-fees});
                results.push({trade_id:trade.trade_id,status:"CLOSED",exit_price:exit,realized_pnl:gross-fees,exit_reason:reason});
              }else results.push({trade_id:trade.trade_id,status:"OPEN"});
            }
            return {checked_candle_at:candle.timestamp,processed:results.length,closed:results.filter(x=>x.status==="CLOSED").length,results,execution_enabled:false};
          },
          monitorTrades:async(tokenHash,symbol,candle,feeBps,checkedAt)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            a.trades??=[];
            const results=[];
            for(const trade of a.trades.filter(t=>t.status==="OPEN"&&t.symbol===symbol)){
              if(trade.last_checked_at&&trade.last_checked_at>=candle.timestamp){results.push({trade_id:trade.trade_id,status:"UNCHANGED"});continue;}
              const buy=trade.side==="BUY",stopHit=buy?candle.low<=trade.stop_loss:candle.high>=trade.stop_loss;
              const targetHit=buy?candle.high>=trade.take_profit:candle.low<=trade.take_profit;
              let exit=null,reason=null;
              if(stopHit){reason="STOP_LOSS";exit=buy&&candle.open<trade.stop_loss?candle.open:!buy&&candle.open>trade.stop_loss?candle.open:trade.stop_loss;}
              else if(targetHit){reason="TAKE_PROFIT";exit=trade.take_profit;}
              trade.last_checked_at=candle.timestamp;
              if(exit!==null){
                const gross=(exit-trade.entry_price)*trade.quantity*(buy?1:-1);
                const exitFee=exit*trade.quantity*feeBps/10000,fees=trade.fees+exitFee;
                Object.assign(trade,{status:"CLOSED",closed_at:checkedAt,exit_price:exit,fees,realized_pnl:gross-fees});
                results.push({trade_id:trade.trade_id,status:"CLOSED",exit_price:exit,realized_pnl:gross-fees,exit_reason:reason});
              }else results.push({trade_id:trade.trade_id,status:"OPEN"});
            }
            return {checked_candle_at:candle.timestamp,processed:results.length,closed:results.filter(x=>x.status==="CLOSED").length,results,execution_enabled:false};
          },
          monitorTradesInternal(symbol,candleInput,feeBps,checkedAt){
            const a=accounts.get(name);
            if(!a)return null;
            if(typeof symbol!=="string"||!/^[A-Z0-9_-]{1,20}$/.test(symbol))
              throw new Error("INVALID_MONITOR_SYMBOL");
            if(typeof feeBps!=="number"||!Number.isFinite(feeBps)||feeBps<0||feeBps>1000)
              throw new Error("INVALID_MONITOR_FEE");
            if(typeof checkedAt!=="string"||!Number.isFinite(Date.parse(checkedAt)))
              throw new Error("INVALID_MONITOR_CHECK_TIME");
            const candles=Array.isArray(candleInput)?candleInput:[candleInput];
            if(!candles.length)throw new Error("NO_COMPLETED_CANDLES");
            for(const candle of candles){
              const values=[candle?.open,candle?.high,candle?.low,candle?.close];
              if(!Number.isFinite(Date.parse(candle?.timestamp))||
                !values.every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0)||
                candle.high<Math.max(candle.open,candle.close)||
                candle.low>Math.min(candle.open,candle.close)||candle.high<candle.low)
                throw new Error("INVALID_MONITOR_CANDLE");
            }
            const results=[];
            for(const trade of (a.trades??[]).filter(t=>t.status==="OPEN"&&t.symbol===symbol)){
              for(const candle of candles){
                if(Date.parse(candle.timestamp)<=Date.parse(trade.opened_at))continue;
                if(trade.last_checked_at&&trade.last_checked_at>=candle.timestamp)continue;
                const buy=trade.side==="BUY";
                const stop=buy?candle.low<=trade.stop_loss:candle.high>=trade.stop_loss;
                const target=buy?candle.high>=trade.take_profit:candle.low<=trade.take_profit;
                let exit=null,reason=null;
                if(stop){reason="STOP_LOSS";exit=buy&&candle.open<trade.stop_loss?candle.open:!buy&&candle.open>trade.stop_loss?candle.open:trade.stop_loss;}
                else if(target){reason="TAKE_PROFIT";exit=trade.take_profit;}
                trade.last_checked_at=candle.timestamp;
                if(exit!==null){
                  const gross=(exit-trade.entry_price)*trade.quantity*(buy?1:-1);
                  const exitFee=exit*trade.quantity*feeBps/10000,fees=trade.fees+exitFee;
                  Object.assign(trade,{status:"CLOSED",closed_at:checkedAt,exit_price:exit,fees,realized_pnl:gross-fees});
                  a.notifications??=[];
                  a.notifications.unshift({notification_id:"closed:"+trade.trade_id,event_type:"TRADE_CLOSED",trade_id:trade.trade_id,
                    title:reason==="STOP_LOSS"?"موقعیت با حد ضرر بسته شد":"موقعیت با حد سود بسته شد",
                    message:trade.symbol+" • سود/زیان: "+(gross-fees).toFixed(2),realized_pnl:gross-fees,created_at:checkedAt,metadata:{}});
                  results.push({trade_id:trade.trade_id,status:"CLOSED",exit_price:exit,realized_pnl:gross-fees,exit_reason:reason});
                  break;
                }
              }
            }
            return {processed:results.length,closed:results.filter(x=>x.status==="CLOSED").length,
              checked_candle_at:candles.at(-1)?.timestamp,results,execution_enabled:false};
          },
          getStrategyAttribution:async(tokenHash)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            const rows=(a.trades??[]).filter(x=>x.status==="CLOSED");
            const grouped=new Map();
            for(const trade of rows){
              const key=(trade.strategy_id||"UNATTRIBUTED")+"|"+(trade.signal_type||"UNATTRIBUTED");
              const g=grouped.get(key)||{strategy_id:trade.strategy_id||"UNATTRIBUTED",
                signal_type:trade.signal_type||"UNATTRIBUTED",closed_trades:0,wins:0,losses:0,net_pnl:0,fees:0,gross_profit:0,gross_loss:0};
              const pnl=Number(trade.realized_pnl||0);g.closed_trades++;g.net_pnl+=pnl;g.fees+=Number(trade.fees||0);
              if(pnl>0){g.wins++;g.gross_profit+=pnl;}else if(pnl<0){g.losses++;g.gross_loss-=pnl;}
              grouped.set(key,g);
            }
            const groups=[...grouped.values()].map(g=>({...g,win_rate_pct:g.closed_trades?g.wins/g.closed_trades*100:0,
              profit_factor:g.gross_loss?g.gross_profit/g.gross_loss:null,expectancy:g.closed_trades?g.net_pnl/g.closed_trades:0,
              sample_quality:g.closed_trades>=20?"MINIMUM_SAMPLE_MET":"INSUFFICIENT_SAMPLE",
              risk_guidance:g.closed_trades>=20&&(g.net_pnl<0||g.wins/g.closed_trades<0.35)?"CONSIDER_HALF_RISK":"NO_AUTOMATIC_CHANGE"}));
            const total=rows.length,attributed=rows.filter(x=>x.strategy_id).length;
            return {groups,total_closed_trades:total,attributed_closed_trades:attributed,
              unattributed_closed_trades:total-attributed,minimum_sample_for_guidance:20,
              guidance_policy:"Advisory only; no automatic risk changes.",mode:"PAPER_ONLY",execution_enabled:false};
          },
          listTrades:async(tokenHash)=>{
            const a=accounts.get(name);
            return !a||a.tokenHash!==tokenHash?null:(a.trades??[]);
          },
          listNotifications:async(tokenHash)=>{
            const a=accounts.get(name);
            return !a||a.tokenHash!==tokenHash?null:(a.notifications??[]);
          },
          getDailyReport:async(tokenHash,day)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            const rows=(a.trades??[]).filter(t=>t.status==="CLOSED"&&t.closed_at?.slice(0,10)===day);
            return {date:day,timezone:"UTC",closed_trades:rows.length,wins:rows.filter(t=>t.realized_pnl>0).length,
              losses:rows.filter(t=>t.realized_pnl<0).length,realized_pnl:rows.reduce((sum,t)=>sum+(t.realized_pnl||0),0),
              fees:rows.reduce((sum,t)=>sum+(t.fees||0),0),mode:"PAPER_ONLY",execution_enabled:false};
          },
          getPerformanceReport:async(tokenHash,period,asOf)=>{
            const a=accounts.get(name);
            if(!a||a.tokenHash!==tokenHash)return null;
            const days=period==="month"?30:7,start=new Date(Date.parse(asOf+"T00:00:00.000Z")-(days-1)*86400000).toISOString().slice(0,10);
            const rows=(a.trades??[]).filter(t=>t.status==="CLOSED"&&t.closed_at>=start+"T00:00:00.000Z"&&t.closed_at.slice(0,10)<=asOf);
            const wins=rows.filter(t=>t.realized_pnl>0),losses=rows.filter(t=>t.realized_pnl<0);
            const grossProfit=wins.reduce((s,t)=>s+t.realized_pnl,0),grossLoss=losses.reduce((s,t)=>s-t.realized_pnl,0);
            const net=rows.reduce((s,t)=>s+t.realized_pnl,0);
            return {period,timezone:"UTC",start_date:start,end_date:asOf,starting_balance:10000,ending_balance:10000+net,
              closed_trades:rows.length,wins:wins.length,losses:losses.length,win_rate_pct:rows.length?wins.length/rows.length*100:0,
              net_pnl:net,fees:rows.reduce((s,t)=>s+t.fees,0),gross_profit:grossProfit,gross_loss:grossLoss,
              profit_factor:grossLoss?grossProfit/grossLoss:null,average_win:wins.length?grossProfit/wins.length:0,
              average_loss:losses.length?grossLoss/losses.length:0,expectancy:rows.length?net/rows.length:0,
              max_drawdown:0,max_drawdown_pct:0,equity_curve:[{date:asOf,balance:10000+net,daily_pnl:net}],
              mode:"PAPER_ONLY",execution_enabled:false};
          }
        };
      }
    }
  };
}

test("paper account creation returns a one-time bearer token and virtual balance",async()=>{
  const env=paperAccountEnv();
  const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.10"},
    body:JSON.stringify({starting_capital:12500,currency:"USD"})
  }),env);
  const body=await response.json();
  assert.equal(response.status,201);
  assert.equal(body.starting_capital,12500);
  assert.equal(body.balance,12500);
  assert.equal(body.currency,"USD");
  assert.equal(body.execution_enabled,false);
  assert.equal(body.trading_enabled,false);
  assert.equal(body.token_type,"Bearer");
  assert.equal(body.access_token.length,64);
  const summary=await worker.fetch(new Request(
    "https://unit.test/v1/paper/accounts/"+body.account_id,
    {headers:{authorization:"Bearer "+body.access_token}}
  ),env);
  const account=await summary.json();
  assert.equal(summary.status,200);
  assert.equal(account.account_id,body.account_id);
  assert.equal(account.balance,12500);
});

test("rejects duplicate open positions for the same symbol without idempotency collision",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.91"},
    body:JSON.stringify({starting_capital:10000,currency:"USD"})
  }),env);
  const account=await created.json();
  const headers={authorization:"Bearer "+account.access_token,"content-type":"application/json"};
  const url="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const payload={symbol:"XAUUSD",side:"BUY",quantity:0.01,entry_price:2000,
    stop_loss:1990,take_profit:2020,idempotency_key:"duplicate-test-001"};
  const first=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify(payload)}),env);
  assert.equal(first.status,201);
  const second=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify({...payload,idempotency_key:"duplicate-test-002"})}),env);
  assert.equal(second.status,409);
  assert.match((await second.json()).error,/open paper trade already exists/i);
});
test("paper API maps aggregate risk guard rejection to HTTP 409",async()=>{
  const env=paperAccountEnv({createTradeError:"TOTAL_OPEN_RISK_LIMIT_EXCEEDED"});
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.89"},
    body:JSON.stringify({starting_capital:10000,currency:"USD"})
  }),env);
  const account=await created.json();
  const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/trades",{
      method:"POST",headers:{authorization:"Bearer "+account.access_token,"content-type":"application/json"},
      body:JSON.stringify({symbol:"EURUSD",side:"BUY",quantity:1,entry_price:100,
        stop_loss:90,take_profit:120,idempotency_key:"aggregate-api-003"})
    }),env);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,"TOTAL_OPEN_RISK_LIMIT_EXCEEDED");
});

test("strategy attribution requires explicit metadata and returns advisory-only risk guidance",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.88"},
    body:JSON.stringify({starting_capital:10000,currency:"USD"})
  }),env);
  const account=await created.json();
  const headers={authorization:"Bearer "+account.access_token,"content-type":"application/json"};
  const opened=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/trades",{
    method:"POST",headers,body:JSON.stringify({symbol:"XAUUSD",side:"BUY",quantity:0.01,
      entry_price:2000,stop_loss:1990,take_profit:2020,strategy_id:"EMA20_50",
      signal_id:"sig-20261125-001",signal_type:"BUY",idempotency_key:"strategy-test-001"})
  }),env);
  assert.equal(opened.status,201);
  const trade=await opened.json();
  assert.equal(trade.strategy_id,"EMA20_50");
  assert.equal(trade.signal_id,"sig-20261125-001");
  await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+
    "/trades/"+trade.trade_id+"/close",{method:"POST",headers,body:JSON.stringify({exit_price:2010})}),env);
  const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/analytics/strategy",{headers}),env);
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.total_closed_trades,1);
  assert.equal(body.attributed_closed_trades,1);
  assert.equal(body.groups[0].strategy_id,"EMA20_50");
  assert.equal(body.groups[0].signal_type,"BUY");
  assert.equal(body.groups[0].sample_quality,"INSUFFICIENT_SAMPLE");
  assert.equal(body.groups[0].risk_guidance,"NO_AUTOMATIC_CHANGE");
  assert.equal(body.execution_enabled,false);
  const denied=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/analytics/strategy",{headers:{authorization:"Bearer "+"a".repeat(64)}}),env);
  assert.equal(denied.status,404);
});

test("paper trade closure creates authenticated in-app notification and daily PnL report",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.77"},
    body:JSON.stringify({starting_capital:10000,currency:"USD"})
  }),env);
  const account=await created.json();
  const headers={authorization:"Bearer "+account.access_token,"content-type":"application/json"};
  const opened=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/trades",{
    method:"POST",headers,body:JSON.stringify({symbol:"XAUUSD",side:"BUY",quantity:0.01,
      entry_price:2000,stop_loss:1990,take_profit:2020,idempotency_key:"notify-test-001"})
  }),env);
  const trade=await opened.json();
  assert.equal(opened.status,201);
  const closed=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+
    "/trades/"+trade.trade_id+"/close",{method:"POST",headers,body:JSON.stringify({exit_price:2010})}),env);
  assert.equal(closed.status,200);
  const notifications=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/notifications",{headers}),env);
  const notificationBody=await notifications.json();
  assert.equal(notifications.status,200);
  assert.equal(notificationBody.notifications.length,1);
  assert.equal(notificationBody.notifications[0].trade_id,trade.trade_id);
  const day=notificationBody.notifications[0].created_at.slice(0,10);
  const report=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/report/daily?date="+day,{headers}),env);
  const reportBody=await report.json();
  assert.equal(report.status,200);
  assert.equal(reportBody.closed_trades,1);
  assert.equal(reportBody.wins,1);
  assert.equal(reportBody.execution_enabled,false);
  const performance=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/report/performance?period=week&date="+day,{headers}),env);
  const performanceBody=await performance.json();
  assert.equal(performance.status,200);
  assert.equal(performanceBody.period,"week");
  assert.equal(performanceBody.closed_trades,1);
  assert.equal(performanceBody.win_rate_pct,100);
  assert.equal(performanceBody.execution_enabled,false);
  const month=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/report/performance?period=month&date="+day,{headers}),env);
  assert.equal(month.status,200);
  assert.equal((await month.json()).period,"month");
  const invalid=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+
    account.account_id+"/report/performance?period=year&date="+day,{headers}),env);
  assert.equal(invalid.status,400);
});

test("paper ledger lifecycle uses atomic SQLite transactions and idempotent event keys",()=>{
 const source=readFileSync(new URL("./paper_accounts.js",import.meta.url),"utf8");
 assert.match(source,/transactionSync\(\(\)=>this\._createTradeAtomic/);
 assert.match(source,/transactionSync\(\(\)=>this\._closeTradeAtomic/);
 assert.match(source,/transactionSync\(\(\)=>this\._monitorTradesAtomic/);
 assert.match(source,/ACCOUNT_OPENED:/);
 assert.match(source,/TRADE_OPENED:/);
 assert.match(source,/TRADE_CLOSED:/);
 assert.match(source,/LEDGER_IDEMPOTENCY_CONFLICT/);
 assert.match(source,/LEGACY_BACKFILLED/);
 assert.match(source,/LEDGER_MIGRATION_INCOMPLETE/);
 assert.doesNotMatch(source,/sql\.exec\(["'`]BEGIN TRANSACTION/);
});

test("paper account integrity endpoint is authenticated and read-only",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.10"},
    body:JSON.stringify({starting_capital:12000})
  }),env);
  const account=await created.json();
  const url="https://unit.test/v1/paper/accounts/"+account.account_id+"/integrity";
  const unauthorized=await worker.fetch(new Request(url),env);
  assert.equal(unauthorized.status,401);
  const malformed=await worker.fetch(new Request(url,{
    headers:{authorization:"Bearer "+"short"}
  }),env);
  assert.equal(malformed.status,401);
  const wrongToken=await worker.fetch(new Request(url,{
    headers:{authorization:"Bearer "+"f".repeat(64)}
  }),env);
  assert.equal(wrongToken.status,404);
  const response=await worker.fetch(new Request(url,{
    headers:{authorization:"Bearer "+account.access_token}
  }),env);
  const report=await response.json();
  assert.equal(response.status,200);
  assert.equal(report.integrity_status,"PARTIAL");
  assert.equal(report.ledger.status,"NOT_IMPLEMENTED");
  assert.equal(report.discrepancy_count,0);
  assert.equal(report.derived_balance,12000);
  assert.equal(report.mode,"PAPER_ONLY");
  assert.equal(report.execution_enabled,false);
  assert.equal(report.ledger.events,0);
  assert.equal(env.__accounts.get(account.account_id).trades?.length||0,0);
});

test("paper account integrity endpoint surfaces detected discrepancies without hiding them",async()=>{
  const env=paperAccountEnv({integrityOverride:{
    integrity_status:"NEEDS_REVIEW",discrepancy_count:1,
    discrepancies:[{code:"REALIZED_PNL_MISMATCH",trade_id:"paper-test-1"}],
    ledger:{events:0,status:"NOT_IMPLEMENTED"},mode:"PAPER_ONLY",execution_enabled:false
  }});
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.13"},
    body:JSON.stringify({starting_capital:15000})
  }),env);
  const account=await created.json();
  const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/integrity",{
    headers:{authorization:"Bearer "+account.access_token}
  }),env);
  const report=await response.json();
  assert.equal(response.status,200);
  assert.equal(report.integrity_status,"NEEDS_REVIEW");
  assert.equal(report.discrepancy_count,1);
  assert.equal(report.discrepancies[0].code,"REALIZED_PNL_MISMATCH");
  assert.equal(report.execution_enabled,false);
});

test("paper account endpoints reject missing and invalid bearer tokens",async()=>{
  const env=paperAccountEnv();
  const missing=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+"a".repeat(32)),env);
  assert.equal(missing.status,401);
  const invalid=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+"a".repeat(32),
    {headers:{authorization:"Bearer "+"x".repeat(40)}}),env);
  assert.equal(invalid.status,404);
});

test("paper account creation validates JSON number types, currency and per-network limits",async()=>{
  const invalidCapital=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.11"},
    body:JSON.stringify({starting_capital:"10000"})
  }),paperAccountEnv());
  assert.equal(invalidCapital.status,400);
  const invalidCurrency=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.12"},
    body:JSON.stringify({currency:"EUR"})
  }),paperAccountEnv());
  assert.equal(invalidCurrency.status,400);
  const limited=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.13"},
    body:JSON.stringify({})
  }),paperAccountEnv({allow:false}));
  assert.equal(limited.status,429);
});

test("paper account trade journal endpoint requires a valid account token",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.14"},
    body:JSON.stringify({})
  }),env);
  const account=await created.json();
  const response=await worker.fetch(new Request(
    "https://unit.test/v1/paper/accounts/"+account.account_id+"/trades",
    {headers:{authorization:"Bearer "+account.access_token}}
  ),env);
  const body=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(body.trades,[]);
  assert.equal(body.execution_enabled,false);
});


test("paper trade endpoint validates direction, stores trades and supports idempotency",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.20"},body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const url="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const bad=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify({symbol:"XAUUSD",side:"BUY",quantity:1,entry_price:2000,stop_loss:2010,take_profit:2040})}),env);
  assert.equal(bad.status,400);
  const payload={symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020,idempotency_key:"order-key-0001"};
  const first=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify(payload)}),env);
  const firstBody=await first.json();
  assert.equal(first.status,201);
  assert.equal(firstBody.execution_enabled,false);
  assert.equal(firstBody.status,"OPEN");
  const second=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify(payload)}),env);
  const secondBody=await second.json();
  assert.equal(second.status,201);
  assert.equal(secondBody.trade_id,firstBody.trade_id);
  assert.equal(secondBody.duplicate,true);
  const journal=await worker.fetch(new Request(url,{headers:{authorization:headers.authorization}}),env);
  assert.equal((await journal.json()).trades.length,1);
});

test("paper trade close is authenticated and records realized PnL only in paper mode",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.21"},body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const url="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const opened=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify({
    symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020
  })}),env);
  const trade=await opened.json();
  const unauthorized=await worker.fetch(new Request(url+"/"+trade.trade_id+"/close",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({exit_price:2010})
  }),env);
  assert.equal(unauthorized.status,401);
  const closed=await worker.fetch(new Request(url+"/"+trade.trade_id+"/close",{
    method:"POST",headers,body:JSON.stringify({exit_price:2010,fee_bps:5})
  }),env);
  const body=await closed.json();
  assert.equal(closed.status,200);
  assert.equal(body.status,"CLOSED");
  assert.equal(body.execution_enabled,false);
  assert.ok(body.realized_pnl>0);
});


test("repeated manual close does not duplicate realized PnL or notifications",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.22"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const url="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const opened=await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify({
    symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020
  })}),env);
  const trade=await opened.json();
  const closeRequest=()=>new Request(url+"/"+trade.trade_id+"/close",{
    method:"POST",headers,body:JSON.stringify({exit_price:2010,fee_bps:5})
  });
  const first=await worker.fetch(closeRequest(),env);
  const firstBody=await first.json();
  const second=await worker.fetch(closeRequest(),env);
  const secondBody=await second.json();
  assert.equal(first.status,200);
  assert.equal(second.status,409);
  assert.equal(secondBody.error,"TRADE_NOT_OPEN");
  const state=env.__accounts.get(account.account_id);
  assert.equal(state.trades.filter(t=>t.status==="CLOSED").length,1);
  assert.equal(state.notifications.filter(n=>n.trade_id===trade.trade_id).length,1);
  assert.equal(state.trades[0].realized_pnl,firstBody.realized_pnl);
});

test("paper monitor uses fresh XAUS 15m candles and applies stop-first execution",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.44"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const tradeUrl="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const opened=await worker.fetch(new Request(tradeUrl,{method:"POST",headers,body:JSON.stringify({
    symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020
  })}),env);
  assert.equal(opened.status,201);
  const intervalMs=900000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:70},(_,i)=>{
    const close=2000+i*0.01;
    return {timestamp:new Date(lastClosed-(69-i)*intervalMs).toISOString(),open:close,high:close+0.5,low:close-0.5,close};
  });
  const last=candles[candles.length-1];
  last.open=2000;last.high=2025;last.low=1985;last.close=2005;
  env.__accounts.get(account.account_id).trades[0].opened_at=new Date(Date.parse(last.timestamp)-900000).toISOString();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  try{
    const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers:{authorization:headers.authorization}
    }),env);
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.provider,"XAUS");
    assert.equal(body.market_data_status,"LIVE");
    assert.equal(body.closed,1);
    assert.equal(body.results[0].exit_reason,"STOP_LOSS");
    assert.equal(body.results[0].exit_price,1990);
    assert.equal(body.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("paper monitor uses fresh XAUS 15m candles and applies stop-first execution",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.44"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const tradeUrl="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const opened=await worker.fetch(new Request(tradeUrl,{method:"POST",headers,body:JSON.stringify({
    symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020
  })}),env);
  assert.equal(opened.status,201);
  const intervalMs=900000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:70},(_,i)=>{
    const close=2000+i*0.01;
    return {timestamp:new Date(lastClosed-(69-i)*intervalMs).toISOString(),open:close,high:close+0.5,low:close-0.5,close};
  });
  const last=candles[candles.length-1];
  last.open=2000;last.high=2025;last.low=1985;last.close=2005;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200,headers:{"content-type":"application/json"}});
  try{
    const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers:{authorization:headers.authorization}
    }),env);
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.provider,"XAUS");
    assert.equal(body.market_data_status,"LIVE");
    assert.equal(body.closed,1);
    assert.equal(body.results[0].exit_reason,"STOP_LOSS");
    assert.equal(body.results[0].exit_price,1990);
    assert.equal(body.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("manual paper monitor does not update positions when XAUS feed is unavailable",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.79"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response("upstream unavailable",{status:503});
  try{
    const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers:{authorization:"Bearer "+account.access_token}
    }),env);
    const body=await response.json();
    assert.equal(response.status,502);
    assert.equal(body.status,"UNAVAILABLE");
    assert.equal(body.execution_enabled,false);
    assert.equal(env.__accounts.get(account.account_id).trades?.length||0,0);
  }finally{globalThis.fetch=originalFetch;}
});

test("manual paper monitor preserves positions during outage and resumes on fresh continuous feed",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.81"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const tradeUrl="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const opened=await worker.fetch(new Request(tradeUrl,{method:"POST",headers,body:JSON.stringify({
    symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020
  })}),env);
  assert.equal(opened.status,201);
  const trade=env.__accounts.get(account.account_id).trades[0];
  const intervalMs=900000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:70},(_,i)=>{
    const close=2000+i*.01;
    return {timestamp:new Date(lastClosed-(69-i)*intervalMs).toISOString(),open:close,high:close+.5,low:close-.5,close};
  });
  trade.opened_at=new Date(Date.parse(candles.at(-1).timestamp)-intervalMs).toISOString();
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response("upstream unavailable",{status:503});
    const unavailable=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers:{authorization:headers.authorization}
    }),env);
    const unavailableBody=await unavailable.json();
    assert.equal(unavailable.status,502);
    assert.equal(unavailableBody.status,"UNAVAILABLE");
    assert.equal(trade.status,"OPEN");
    assert.equal(trade.last_checked_at,undefined);
    assert.equal(env.__accounts.get(account.account_id).notifications?.length||0,0);

    globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
    const recovered=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers:{authorization:headers.authorization}
    }),env);
    const recoveredBody=await recovered.json();
    assert.equal(recovered.status,200,JSON.stringify(recoveredBody));
    assert.equal(recoveredBody.market_data_status,"LIVE");
    assert.equal(recoveredBody.closed,0);
    assert.equal(trade.status,"OPEN");
    assert.equal(trade.last_checked_at,candles.at(-1).timestamp);
    assert.equal(recoveredBody.execution_enabled,false);
  } finally {globalThis.fetch=originalFetch;}
});

test("manual paper monitor blocks gapped live candles without changing positions",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.82"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const headers={"content-type":"application/json",authorization:"Bearer "+account.access_token};
  const opened=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/trades",{
    method:"POST",headers,body:JSON.stringify({
      symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020
    })
  }),env);
  assert.equal(opened.status,201);
  const trade=env.__accounts.get(account.account_id).trades[0];
  const intervalMs=900000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:70},(_,i)=>{
    const close=2000+i*.01;
    return {timestamp:new Date(lastClosed-(69-i)*intervalMs).toISOString(),open:close,high:close+.5,low:close-.5,close};
  });
  trade.opened_at=new Date(Date.parse(candles.at(-1).timestamp)-intervalMs).toISOString();
  candles.splice(30,1);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
  try {
    const response=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers:{authorization:headers.authorization}
    }),env);
    const body=await response.json();
    assert.equal(response.status,502);
    assert.equal(body.status,"UNAVAILABLE");
    assert.match(body.error,/continuous XAUS 15m candles/i);
    assert.equal(trade.status,"OPEN");
    assert.equal(trade.last_checked_at,undefined);
    assert.equal(env.__accounts.get(account.account_id).notifications?.length||0,0);
  } finally {globalThis.fetch=originalFetch;}
});

test("paper monitor processes each completed candle only once",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.77"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const headers={authorization:"Bearer "+account.access_token};
  const opened=await worker.fetch(new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/trades",{
    method:"POST",headers:{"content-type":"application/json",...headers},
    body:JSON.stringify({symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020})
  }),env);
  assert.equal(opened.status,201);
  const intervalMs=900000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:70},(_,i)=>{
    const close=2000+i*.01;
    return {timestamp:new Date(lastClosed-(69-i)*intervalMs).toISOString(),
      open:close,high:close+.5,low:close-.5,close};
  });
  env.__accounts.get(account.account_id).trades[0].opened_at=
    new Date(Date.parse(candles.at(-1).timestamp)-intervalMs).toISOString();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
  try{
    const request=()=>new Request("https://unit.test/v1/paper/accounts/"+account.account_id+"/monitor",{
      method:"POST",headers
    });
    const first=await (await worker.fetch(request(),env)).json();
    const second=await (await worker.fetch(request(),env)).json();
    assert.equal(first.processed,1);
    assert.equal(first.results[0].status,"OPEN");
    assert.equal(second.processed,1);
    assert.equal(second.results[0].status,"UNCHANGED");
    assert.equal(second.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("paper account monitor rejects malformed OHLC values before updating positions",async()=>{
  const env=paperAccountEnv();
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.78"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const accountDO=env.PAPER_ACCOUNTS.getByName(account.account_id);
  const malformed={timestamp:new Date().toISOString(),open:2000,high:1990,low:1980,close:2005};
  assert.throws(()=>accountDO.monitorTradesInternal("XAUUSD",malformed,5,new Date().toISOString()),
    /INVALID_MONITOR_CANDLE/);
  assert.equal(env.__accounts.get(account.account_id).trades?.length||0,0);
});

test("scheduled monitor checks every registered paper account using fresh completed XAUS candle",async()=>{
  const statusStore=new Map();
  const env=paperAccountEnv();
  env.SIGNAL_HISTORY={put:async(key,value)=>statusStore.set(key,JSON.parse(value)),
    get:async(key)=>statusStore.get(key)||null};
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.55"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const tradeUrl="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const opened=await worker.fetch(new Request(tradeUrl,{method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+account.access_token},
    body:JSON.stringify({symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020})
  }),env);
  assert.equal(opened.status,201);
  const intervalMs=900000,lastClosed=Math.floor(Date.now()/intervalMs)*intervalMs-intervalMs;
  const candles=Array.from({length:70},(_,i)=>{
    const close=2000+i*.01;
    return {timestamp:new Date(lastClosed-(69-i)*intervalMs).toISOString(),open:close,high:close+.5,low:close-.5,close};
  });
  Object.assign(candles.at(-1),{open:2000,high:2005,low:1985,close:1995});
  env.__accounts.get(account.account_id).trades[0].opened_at=new Date(Date.parse(candles.at(-1).timestamp)-900000).toISOString();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(xausChartFixture(candles)),{status:200});
  try{
    const result=await worker.scheduled({cron:"*/5 * * * *",scheduledTime:Date.now()},env);
    assert.equal(result.status,"OK");
    assert.equal(result.accounts_checked,1);
    assert.equal(result.closed_trades,1,JSON.stringify(result));
    assert.equal(result.provider,"XAUS");
    assert.equal(result.execution_enabled,false);
    assert.equal(statusStore.get("paper-monitor:latest").status,"OK");
    const statusResponse=await worker.fetch(new Request("https://unit.test/v1/paper/monitor/status"),env);
    const statusBody=await statusResponse.json();
    assert.equal(statusResponse.status,200);
    assert.equal(statusBody.status,"OK");
    assert.equal(statusBody.monitor.closed_trades,1);
    assert.equal(statusBody.execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("Wrangler config preserves signal history and declares SQLite paper accounts",()=>{
  const config=JSON.parse(readFileSync(new URL("./wrangler.jsonc",import.meta.url),"utf8"));
  assert.equal(config.name,"ayyar-smart-trader-api");
  assert.equal(config.main,"worker.js");
  assert.deepEqual(config.triggers.crons,["*/5 * * * *"]);
  assert.deepEqual(config.kv_namespaces,[{
    binding:"SIGNAL_HISTORY",id:"e3de061386ae467aae8f4d8da1e0e408"
  }]);
  assert.deepEqual(config.durable_objects.bindings,[{
    name:"PAPER_ACCOUNTS",class_name:"PaperAccount"
  }]);
  assert.deepEqual(config.migrations,[{
    tag:"v1-paper-accounts",new_sqlite_classes:["PaperAccount"]
  }]);
});


test("market snapshot reports PARTIAL instead of LIVE when only some instruments are fresh", async () => {
  const isolatedWorker = (await import("./worker_core.js?partial-market-status-test")).default;
  globalThis.fetch = async () => new Response(JSON.stringify({
    generated_utc:new Date().toISOString(),
    items:[{id:"gold-18k",price:7200000,unit:"IRT",updated_utc:new Date().toISOString(),stale:false}]
  }),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/quotes"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.status,"PARTIAL");
    assert.equal(body.live_quotes,1);
    assert.equal(body.total_quotes,8);
    assert.equal(body.quotes.filter(q=>q.status==="LIVE").length,1);
  } finally { globalThis.fetch=originalFetch; }
});


test("market status endpoint exposes accurate partial quote counts", async () => {
  const isolatedWorker=(await import("./worker_core.js?market-status-partial-test")).default;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    generated_utc:new Date().toISOString(),
    items:[{id:"gold-18k",price:7200000,unit:"IRT",updated_utc:new Date().toISOString(),stale:false}]
  }),{status:200,headers:{"content-type":"application/json"}});
  try {
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/status"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.status,"PARTIAL");
    assert.equal(body.live_quotes,1);
    assert.equal(body.total_quotes,8);
  } finally { globalThis.fetch=originalFetch; }
});

test("market status endpoint reports zero live quotes when providers fail", async () => {
  const isolatedWorker=(await import("./worker_core.js?market-status-unavailable-test")).default;
  globalThis.fetch=async()=>new Response("upstream unavailable",{status:503});
  try {
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/status"));
    const body=await response.json();
    assert.equal(response.status,200);
    assert.equal(body.status,"UNAVAILABLE");
    assert.equal(body.live_quotes,0);
    assert.equal(body.total_quotes,8);
  } finally { globalThis.fetch=originalFetch; }
});

test("market snapshot recovers immediately after provider outage without serving cached UNAVAILABLE", async () => {
  const isolatedWorker=(await import("./worker_core.js?market-outage-recovery-test")).default;
  let providerCalls=0,spotFallbackCalls=0;
  globalThis.fetch=async url=>{
    if(String(url).includes("xaus.com/api/v1/spot")) {
      spotFallbackCalls++;
      return new Response(JSON.stringify({data_state:{status:"unavailable"}}),
        {status:200,headers:{"content-type":"application/json"}});
    }
    providerCalls++;
    if(providerCalls===1) return new Response("upstream unavailable",{status:503});
    return new Response(JSON.stringify({
      generated_utc:new Date().toISOString(),
      items:freshItems
    }),{status:200,headers:{"content-type":"application/json"}});
  };
  try {
    const first=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/status"));
    const unavailable=await first.json();
    assert.equal(unavailable.status,"UNAVAILABLE");
    assert.equal(unavailable.live_quotes,0);

    const second=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/status"));
    const recovered=await second.json();
    assert.equal(recovered.status,"LIVE");
    assert.equal(recovered.live_quotes,8);
    assert.equal(recovered.total_quotes,8);
    assert.equal(providerCalls,2,"primary market provider must be retried after an unavailable snapshot");
    assert.equal(spotFallbackCalls,1,"XAUS spot fallback should be attempted only during the outage");
  } finally { globalThis.fetch=originalFetch; }
});

test("paper account bearer tokens cannot cross account boundaries or leak from read APIs",async()=>{
  const env=paperAccountEnv();
  const create=async(ip)=>worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const first=await (await create("192.0.2.101")).json();
  const second=await (await create("192.0.2.102")).json();
  assert.notEqual(first.account_id,second.account_id);
  assert.notEqual(first.access_token,second.access_token);

  const protectedPaths=[
    "",
    "/trades",
    "/integrity",
    "/notifications",
    "/report/daily",
    "/report/performance",
    "/analytics/strategy"
  ];
  for(const suffix of protectedPaths){
    const response=await worker.fetch(new Request(
      "https://unit.test/v1/paper/accounts/"+second.account_id+suffix,
      {headers:{authorization:"Bearer "+first.access_token}}
    ),env);
    assert.equal(response.status,404,"cross-account access must be denied for "+suffix);
    const body=await response.text();
    assert.ok(!body.includes(first.access_token),"bearer token must not appear in error response");
  }

  for(const suffix of protectedPaths){
    const response=await worker.fetch(new Request(
      "https://unit.test/v1/paper/accounts/"+first.account_id+suffix,
      {headers:{authorization:"Bearer "+first.access_token}}
    ),env);
    assert.ok(response.status===200||response.status===400,
      "owner token should reach its resource for "+suffix+" (got "+response.status+")");
    const body=await response.text();
    assert.ok(!body.includes(first.access_token),"bearer token must never be echoed by read APIs");
  }
});



test("BIQUOTE is a validated XAUUSD OHLC fallback when XAUS candle freshness metadata is invalid",async()=>{
  const isolatedWorker=(await import("./worker_core.js?biquote-xau-fallback-test")).default;
  const intervalMs=15*60*1000;
  const currentBucket=Math.floor(Date.now()/intervalMs)*intervalMs;
  const bars=[{openTime:new Date(currentBucket).toISOString(),open:3510,high:3512,low:3509,close:3511,
    volume:0,tickVolume:12,isOpen:true}];
  for(let i=0;i<120;i++){
    const openTime=currentBucket-(i+1)*intervalMs;
    const open=3500+i*0.1,close=open+0.2;
    bars.push({openTime:new Date(openTime).toISOString(),open,high:close+0.1,low:open-0.1,
      close,volume:0,tickVolume:100+i,isOpen:false});
  }
  globalThis.fetch=async(url)=>{
    if(String(url).includes("xaus.com/api/v1/chart"))
      return new Response(JSON.stringify({data_state:{status:"stale",as_of:"2020-01-01T00:00:00Z",age_seconds:999999},points:[]}),
        {status:200,headers:{"content-type":"application/json"}});
    if(String(url).includes("biquote.io/api/XAUUSD/ohlc"))
      return new Response(JSON.stringify({symbol:"XAUUSD",interval:"15m",bars}),
        {status:200,headers:{"content-type":"application/json"}});
    throw new Error("Unexpected provider URL: "+url);
  };
  try{
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=15m"));
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.status,"LIVE");
    assert.equal(body.provider,"BIQUOTE");
    assert.equal(body.candles.length,120);
    assert.equal(body.data_quality.status,"CLEAN");
    assert.equal(body.data_quality.missing_intervals,0);
    assert.ok(body.age_seconds>=0&&body.age_seconds<900);
    assert.equal(body.fallback_reason,"XAUS OHLC provider data state is stale");
    assert.ok(body.candles.every(c=>Number.isFinite(Date.parse(c.timestamp))));
  }finally{globalThis.fetch=originalFetch;}
});

test("BIQUOTE fallback rejects stale completed candles instead of fabricating a live feed",async()=>{
  const isolatedWorker=(await import("./worker_core.js?biquote-xau-stale-fallback-test")).default;
  const intervalMs=15*60*1000;
  const currentBucket=Math.floor(Date.now()/intervalMs)*intervalMs;
  const bars=[];
  for(let i=0;i<80;i++){
    const openTime=currentBucket-3*60*60*1000-i*intervalMs;
    const open=3500+i*0.1,close=open+0.2;
    bars.push({openTime:new Date(openTime).toISOString(),open,high:close+0.1,low:open-0.1,
      close,volume:0,tickVolume:100+i,isOpen:false});
  }
  globalThis.fetch=async(url)=>{
    if(String(url).includes("xaus.com/api/v1/chart"))
      return new Response(JSON.stringify({data_state:{status:"stale",as_of:"2020-01-01T00:00:00Z",age_seconds:999999},points:[]}),
        {status:200,headers:{"content-type":"application/json"}});
    if(String(url).includes("biquote.io/api/XAUUSD/ohlc"))
      return new Response(JSON.stringify({symbol:"XAUUSD",interval:"15m",bars}),
        {status:200,headers:{"content-type":"application/json"}});
    throw new Error("Unexpected provider URL: "+url);
  };
  try{
    const response=await isolatedWorker.fetch(new Request("https://unit.test/v1/market/candles?symbol=xau&interval=15m"));
    const body=await response.json();
    assert.equal(response.status,502);
    assert.equal(body.status,"UNAVAILABLE");
    assert.match(body.error,/Latest completed BIQUOTE OHLC candle is stale/);
    assert.equal(body.execution_enabled,false);
    assert.deepEqual(body.candles,[]);
  }finally{globalThis.fetch=originalFetch;}
});


test("scheduled paper monitor refuses BIQUOTE candles with gaps and leaves open positions unchanged",async()=>{
  const statusStore=new Map();
  const env=paperAccountEnv();
  env.SIGNAL_HISTORY={put:async(key,value)=>statusStore.set(key,JSON.parse(value)),
    get:async(key)=>statusStore.get(key)||null};
  const created=await worker.fetch(new Request("https://unit.test/v1/paper/accounts",{
    method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"192.0.2.56"},
    body:JSON.stringify({starting_capital:10000})
  }),env);
  const account=await created.json();
  const tradeUrl="https://unit.test/v1/paper/accounts/"+account.account_id+"/trades";
  const opened=await worker.fetch(new Request(tradeUrl,{method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+account.access_token},
    body:JSON.stringify({symbol:"XAUUSD",side:"BUY",quantity:0.1,entry_price:2000,stop_loss:1990,take_profit:2020})
  }),env);
  assert.equal(opened.status,201);
  const intervalMs=900000,currentBucket=Math.floor(Date.now()/intervalMs)*intervalMs;
  const bars=[{openTime:new Date(currentBucket).toISOString(),open:2000,high:2001,low:1999,
    close:2000,volume:0,tickVolume:10,isOpen:true}];
  for(let i=0;i<70;i++){
    if(i===35) continue;
    const openTime=currentBucket-(i+1)*intervalMs;
    const open=2000+i*.01,close=open+.1;
    bars.push({openTime:new Date(openTime).toISOString(),open,high:close+.2,low:open-.2,
      close,volume:0,tickVolume:100+i,isOpen:false});
  }
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url)=>{
    if(String(url).includes("xaus.com/api/v1/chart"))
      return new Response(JSON.stringify({data_state:{status:"stale",as_of:"2020-01-01T00:00:00Z",age_seconds:999999},points:[]}),
        {status:200,headers:{"content-type":"application/json"}});
    if(String(url).includes("biquote.io/api/XAUUSD/ohlc"))
      return new Response(JSON.stringify({symbol:"XAUUSD",interval:"15m",bars}),
        {status:200,headers:{"content-type":"application/json"}});
    throw new Error("Unexpected provider URL: "+url);
  };
  try{
    await assert.rejects(
      worker.scheduled({cron:"*/5 * * * *",scheduledTime:Date.now()},env),
      /candle gap\(s\)/
    );
    const stored=env.__accounts.get(account.account_id).trades[0];
    assert.equal(stored.status,"OPEN");
    assert.equal(statusStore.get("paper-monitor:latest").status,"ERROR");
    assert.match(statusStore.get("paper-monitor:latest").error,/1 candle gap/);
    assert.equal(statusStore.get("paper-monitor:latest").execution_enabled,false);
  }finally{globalThis.fetch=originalFetch;}
});
