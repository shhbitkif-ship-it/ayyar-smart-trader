import { PaperAccount } from "./paper_accounts.js";

export class FaultInjectPaperAccount extends PaperAccount {
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
