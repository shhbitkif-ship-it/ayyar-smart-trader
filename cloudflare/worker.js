const SOURCE = "https://nerkhara.com/api/v1/latest.json";
const MAX_AGE_SECONDS = 660;
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
function normalise(item, def) {
  const [symbol,fallbackName,id,expectedUnit,displayUnit] = def;
  const price=item?.price;
  const validPrice=typeof price==="number" && Number.isFinite(price) && price>0;
  const stamp=parseStamp(item?.updated_utc);
  const age=stamp ? (Date.now()-stamp.getTime())/1000 : null;
  const unitValid=item?.unit===expectedUnit;
  const fresh=Boolean(validPrice && stamp && age>=-30 && age<=MAX_AGE_SECONDS && item?.stale!==true && unitValid);
  return {
    symbol,name:item?.name?.fa || item?.name?.en || fallbackName,
    price:fresh?price:null,unit:displayUnit,source:"NerkhAra",
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
async function snapshot() {
  if(cached && Date.now()-cachedAt<60000) return cached;
  try {
    const response=await fetch(SOURCE,{headers:{accept:"application/json"},cf:{cacheTtl:60,cacheEverything:true}});
    if(!response.ok) throw new Error("Provider HTTP "+response.status);
    const payload=await response.json();
    if(!payload || !Array.isArray(payload.items)) throw new Error("Unexpected provider schema");
    const byId=new Map(payload.items.filter(x=>x&&typeof x==="object").map(x=>[x.id,x]));
    const quotes=SYMBOLS.map(def=>normalise(byId.get(def[2]),def));
    cached={status:quotes.some(q=>q.status==="LIVE")?"LIVE":"UNAVAILABLE",
      as_of:new Date().toISOString(),provider_generated_at:parseStamp(payload.generated_utc)?.toISOString()??null,
      quotes,notice:"NerkhAra refreshes its snapshot every ten minutes. Indicative market data only, not broker execution quotes. Stale or unavailable prices never produce signals.",
      attribution:"NerkhAra — https://nerkhara.com"};
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
  async fetch(request) {
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{headers:{
      "access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS",
      "access-control-allow-headers":"content-type"}});
    if(url.pathname==="/health") return json({status:"ok",service:"ayyar-smart-trader-api",version:"1.0.0"});
    if(url.pathname==="/v1/market/quotes"&&request.method==="GET") return json(await snapshot());
    if(url.pathname==="/v1/market/status"&&request.method==="GET") {
      const s=await snapshot();
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
        return json({allowed:true,lots,risk_amount:riskAmount,risk_fraction:effectiveRisk,
          stop_distance:stopDistance,estimated_loss_at_stop:lots*lossPerLot,
          reason:"Sizing estimate only. Confirm tick value, lot step, margin, spread and broker rules before any order."});
      } catch { return json({error:"Request body must be valid JSON"},400); }
    }
    if(url.pathname==="/v1/signals/evaluate"&&request.method==="POST") return json({
      signal:"NO_TRADE",confidence:0,
      reason:"Technical-history validation and independent signal verification are not enabled in this public-data build.",
      execution_enabled:false});
    return json({error:"Not found"},404);
  }
};