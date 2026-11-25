import { PaperAccount } from "./paper_accounts.js";

export class FaultInjectPaperAccount extends PaperAccount {
  seedLegacyAccount({accountId,tokenHash,startingCapital,createdAt,trades=[]}) {
    this.ctx.storage.sql.exec(
      "INSERT INTO accounts(account_id,token_hash,currency,starting_capital,created_at) VALUES(?,?,?,?,?)",
      accountId,tokenHash,"USD",startingCapital,createdAt
    );
    for (const trade of trades) {
      this.ctx.storage.sql.exec(
        `INSERT INTO paper_trades(trade_id,symbol,side,quantity,entry_price,stop_loss,take_profit,
          status,opened_at,closed_at,exit_price,realized_pnl,fees,idempotency_key)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        trade.trade_id,trade.symbol,trade.side,trade.quantity,trade.entry_price,
        trade.stop_loss,trade.take_profit,trade.status,trade.opened_at,
        trade.closed_at??null,trade.exit_price??null,trade.realized_pnl??null,
        trade.fees??0,trade.idempotency_key??null
      );
    }
    return {seeded:true,trade_count:trades.length};
  }

  seedPartialLedger({accountId,tokenHash,startingCapital,createdAt}) {
    this.seedLegacyAccount({accountId,tokenHash,startingCapital,createdAt});
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger_entries(event_id,event_type,amount,balance_after,metadata_json,created_at)
       VALUES(?,?,?,?,?,?)`,
      "ACCOUNT_OPENED:"+accountId,"ACCOUNT_OPENED",startingCapital,
      startingCapital,JSON.stringify({account_id:accountId}),createdAt
    );
    return {seeded:true};
  }

  countLedgerRows() {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM ledger_entries").toArray()[0].count);
  }

  setFaultMode(mode) {
    if (!["none", "after-open-ledger", "after-close-ledger", "after-close-notification"].includes(mode))
      throw new Error("INVALID_TEST_FAULT_MODE");
    this.faultMode = mode;
  }

  async runCreateTradeWithFault(tokenHash, trade, createdAt) {
    try { return { ok: true, result: super.createTrade(tokenHash, trade, createdAt) }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }

  async runCloseTradeWithFault(tokenHash, tradeId, exitPrice, feeBps, closedAt) {
    try { return { ok: true, result: super.closeTrade(tokenHash, tradeId, exitPrice, feeBps, closedAt) }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }

  _appendLedgerEntry(account, eventId, eventType, amount, metadata, createdAt) {
    const result = super._appendLedgerEntry(account, eventId, eventType, amount, metadata, createdAt);
    if (this.faultMode === "after-open-ledger" && eventType === "TRADE_OPENED")
      throw new Error("INJECTED_FAILURE_AFTER_OPEN_LEDGER_WRITE");
    if (this.faultMode === "after-close-ledger" && eventType === "TRADE_CLOSED")
      throw new Error("INJECTED_FAILURE_AFTER_LEDGER_WRITE");
    return result;
  }

  _recordClosedNotification(trade, closed, reason, closedAt) {
    super._recordClosedNotification(trade, closed, reason, closedAt);
    if (this.faultMode === "after-close-notification")
      throw new Error("INJECTED_FAILURE_AFTER_NOTIFICATION_WRITE");
  }
}

export default { fetch() { return new Response("integration-test-worker"); } };
