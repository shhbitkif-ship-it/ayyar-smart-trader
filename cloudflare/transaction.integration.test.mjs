import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";

class FaultInjectPaperAccount extends (await import("./paper_accounts.js")).PaperAccount {
  setFaultMode(mode) {
    if (!["none", "after-close-ledger", "after-close-notification"].includes(mode))
      throw new Error("INVALID_TEST_FAULT_MODE");
    this.faultMode = mode;
  }

  _appendLedgerEntry(account, eventId, eventType, amount, metadata, createdAt) {
    const result = super._appendLedgerEntry(account, eventId, eventType, amount, metadata, createdAt);
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

let mf;
let namespace;

before(async () => {
  mf = new Miniflare({
    scriptPath: "./transaction_test_worker.mjs",
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-07-30",
    durableObjects: {
      PAPER_ACCOUNTS: { className: "FaultInjectPaperAccount", useSQLite: true }
    },
    kvNamespaces: ["SIGNAL_HISTORY"],
    cf: false
  });
  await mf.ready;
  namespace = await mf.getDurableObjectNamespace("PAPER_ACCOUNTS");
});

after(async () => {
  await mf?.dispose();
});

let accountCounter = 0;
async function makeAccount() {
  const accountId = "sqlite-rollback-" + (++accountCounter);
  const tokenHash = "token-hash-" + accountCounter;
  const stub = namespace.get(namespace.idFromName(accountId));
  const createdAt = "2026-11-25T08:00:00.000Z";
  await stub.createAccount(accountId, tokenHash, "USD", 100000, createdAt);
  const trade = {
    trade_id: "trade-" + accountCounter,
    symbol: "XAUUSD",
    side: "BUY",
    quantity: 1,
    entry_price: 100,
    stop_loss: 90,
    take_profit: 120,
    fee_bps: 5,
    idempotency_key: "idem-" + accountCounter
  };
  await stub.createTrade(tokenHash, trade, "2026-11-25T08:01:00.000Z");
  return { stub, tokenHash, tradeId: trade.trade_id };
}

for (const fault of ["after-close-ledger", "after-close-notification"]) {
  test("SQLite transaction rolls back trade, ledger and notification when failure occurs " + fault, async () => {
    const { stub, tokenHash, tradeId } = await makeAccount();
    const before = await stub.getSummary(tokenHash);
    await stub.setFaultMode(fault);

    await assert.rejects(
      stub.closeTrade(tokenHash, tradeId, 110, 5, "2026-11-25T08:02:00.000Z"),
      new RegExp(fault === "after-close-ledger"
        ? "INJECTED_FAILURE_AFTER_LEDGER_WRITE"
        : "INJECTED_FAILURE_AFTER_NOTIFICATION_WRITE")
    );

    await stub.setFaultMode("none");
    const tradesAfterFailure = await stub.listTrades(tokenHash);
    const notificationsAfterFailure = await stub.listNotifications(tokenHash);
    const afterFailure = await stub.getSummary(tokenHash);
    const integrityAfterFailure = await stub.getIntegrityReport(tokenHash);

    assert.equal(tradesAfterFailure.length, 1);
    assert.equal(tradesAfterFailure[0].status, "OPEN");
    assert.equal(tradesAfterFailure[0].closed_at, null);
    assert.equal(notificationsAfterFailure.length, 0);
    assert.equal(afterFailure.balance, before.balance);
    assert.equal(afterFailure.ledger_events, before.ledger_events);
    assert.equal(integrityAfterFailure.integrity_status, "CLEAN",
      JSON.stringify(integrityAfterFailure.discrepancies));

    const closed = await stub.closeTrade(tokenHash, tradeId, 110, 5, "2026-11-25T08:03:00.000Z");
    assert.equal(closed.status, "CLOSED");
    assert.equal((await stub.listTrades(tokenHash))[0].status, "CLOSED");
    assert.equal((await stub.listNotifications(tokenHash)).length, 1);
    const finalIntegrity = await stub.getIntegrityReport(tokenHash);
    assert.equal(finalIntegrity.integrity_status, "CLEAN",
      JSON.stringify(finalIntegrity.discrepancies));
    assert.equal(finalIntegrity.execution_enabled, false);
  });
}
