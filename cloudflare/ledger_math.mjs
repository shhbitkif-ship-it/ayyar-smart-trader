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
