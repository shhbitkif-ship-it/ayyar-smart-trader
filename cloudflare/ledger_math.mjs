export function calculatePaperEntryFee(quantity,entryPrice,feeBps) {
  if(!Number.isFinite(quantity)||quantity<=0||
    !Number.isFinite(entryPrice)||entryPrice<=0||
    !Number.isFinite(feeBps)||feeBps<0||feeBps>1000)
    throw new Error("INVALID_PAPER_FEE_INPUT");
  const fee=quantity*entryPrice*feeBps/10000;
  if(!Number.isFinite(fee)||fee<0) throw new Error("PAPER_FEE_OUT_OF_RANGE");
  return fee;
}

export function calculatePaperSettlement({side,quantity,entryPrice,exitPrice,entryFee,exitFee}) {
  if(!["BUY","SELL"].includes(side)||
    !Number.isFinite(quantity)||quantity<=0||
    !Number.isFinite(entryPrice)||entryPrice<=0||
    !Number.isFinite(exitPrice)||exitPrice<=0||
    !Number.isFinite(entryFee)||entryFee<0||
    !Number.isFinite(exitFee)||exitFee<0)
    throw new Error("INVALID_PAPER_SETTLEMENT_INPUT");
  const gross=(exitPrice-entryPrice)*quantity*(side==="BUY"?1:-1);
  const totalFees=entryFee+exitFee;
  const realizedPnl=gross-totalFees;
  // Entry fees are deducted when the position opens. The close event therefore
  // records gross PnL less exit fees, avoiding a second deduction of entry fees.
  const ledgerCloseAmount=gross-exitFee;
  if(![gross,totalFees,realizedPnl,ledgerCloseAmount].every(Number.isFinite))
    throw new Error("PAPER_SETTLEMENT_OUT_OF_RANGE");
  return {gross,entryFee,exitFee,totalFees,realizedPnl,ledgerCloseAmount};
}

function stableLedgerJson(value) {
  if(Array.isArray(value)) return "["+value.map(stableLedgerJson).join(",")+"]";
  if(value&&typeof value==="object")
    return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableLedgerJson(value[key])).join(",")+"}";
  return JSON.stringify(value);
}

export function ledgerEventReplayMatches(existing,{eventType,amount,metadata,createdAt}) {
  if(!existing||typeof existing!=="object") return false;
  if(existing.event_type!==eventType||!Number.isFinite(Number(existing.amount))||
    Math.abs(Number(existing.amount)-amount)>1e-8*Math.max(1,Math.abs(amount))||
    existing.created_at!==createdAt) return false;
  try {
    return stableLedgerJson(JSON.parse(existing.metadata_json))===stableLedgerJson(metadata);
  } catch {
    return false;
  }
}
