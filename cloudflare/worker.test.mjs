import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const originalFetch = globalThis.fetch;
const freshItems = [
  ["gold-18k","IRT",7200000],["gold-24k","IRT",9600000],
  ["gold-mesghal","IRT",31200000],["coin-emami","IRT",78000000],
  ["coin-half","IRT",42000000],["coin-quarter","IRT",25000000],
  ["usd","IRT",70000],["xau","USD",2650]
].map(([id,unit,price]) => ({id,unit,price,updated_utc:new Date().toISOString(),stale:false}));

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
