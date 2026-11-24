const ENDPOINT = "https://talasanj.info/api/v1/prices";
const MAP = [
  ["gold-18k","gram18","IRT"],["gold-24k","gram24","IRT"],
  ["gold-mesghal","mazaneh","IRT"],["coin-emami","coin_full","IRT"],
  ["coin-half","coin_half","IRT"],["coin-quarter","coin_quarter","IRT"],
  ["usd","usd","IRT"],["xau","ounce","USD"]
];

export async function fetchTalasanj(env={}) {
  const key=env?.TALASANJ_API_KEY;
  if(!key) return null;
  try {
    const response=await fetch(ENDPOINT,{
      headers:{accept:"application/json",authorization:"Bearer "+key,
        "X-Client-Name":"Ayyar Smart Trader","X-Client-Url":"https://t.me/AyyarSmartTraderBot"},
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok) throw new Error("Talasanj HTTP "+response.status);
    const body=await response.json();
    if(!body?.prices || typeof body.prices!=="object" || !body.updated_at) throw new Error("Invalid Talasanj response");
    const items=MAP.flatMap(([id,symbol,unit])=>{
      const row=body.prices[symbol],price=row?.price;
      const updated=row?.updated_at||body.updated_at;
      const stamp=typeof updated==="string"?Date.parse(updated):NaN;
      const age=(Date.now()-stamp)/1000;
      const validPrice=typeof price==="number"&&Number.isFinite(price)&&price>0;
      const fresh=Number.isFinite(stamp)&&age>=-30&&age<=90;
      return validPrice&&fresh?[{id,price,unit,updated_utc:updated,stale:false}]:[];
    });
    return {generated_utc:body.updated_at,items};
  } catch { return null; }
}
