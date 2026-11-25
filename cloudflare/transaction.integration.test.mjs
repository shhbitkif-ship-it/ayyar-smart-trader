import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";

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
  await stub.createAccount(accountId, tokenHash, "USD", 100000, "2026-11-25T08:00:00.000Z");
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

test("SQLite transaction rolls back a newly inserted trade when opening ledger write fails", async () => {
  const accountId = "sqlite-open-rollback";
  const tokenHash = "token-hash-open-rollback";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId, tokenHash, "USD", 100000, "2026-11-25T08:00:00.000Z");
  await stub.setFaultMode("after-open-ledger");
  const trade = {
    trade_id: "trade-open-rollback", symbol: "XAUUSD", side: "BUY",
    quantity: 1, entry_price: 100, stop_loss: 90, take_profit: 120,
    fee_bps: 5, idempotency_key: "idem-open-rollback"
  };
  const failedOpen = await stub.runCreateTradeWithFault(tokenHash, trade, "2026-11-25T08:01:00.000Z");
  assert.equal(failedOpen.ok, false);
  assert.match(failedOpen.error, /INJECTED_FAILURE_AFTER_OPEN_LEDGER_WRITE/);
  await stub.setFaultMode("none");
  assert.equal((await stub.listTrades(tokenHash)).length, 0);
  const summary = await stub.getSummary(tokenHash);
  assert.equal(summary.ledger_events, 1);
  assert.equal(summary.balance, 100000);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status, "CLEAN", JSON.stringify(integrity.discrepancies));
  const created = await stub.createTrade(tokenHash, trade, "2026-11-25T08:02:00.000Z");
  assert.equal(created.status, "OPEN");
  assert.equal((await stub.listTrades(tokenHash)).length, 1);
});
test("legacy account migration backfills ledger once and preserves derived balance", async () => {
  const accountId = "sqlite-legacy-backfill";
  const tokenHash = "token-hash-legacy-backfill";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.seedLegacyAccount({
    accountId, tokenHash, startingCapital: 100000,
    createdAt: "2026-11-25T07:00:00.000Z",
    trades: [
      { trade_id:"legacy-closed",symbol:"XAUUSD",side:"BUY",quantity:1,
        entry_price:100,stop_loss:90,take_profit:120,status:"CLOSED",
        opened_at:"2026-11-25T07:10:00.000Z",closed_at:"2026-11-25T07:20:00.000Z",
        exit_price:110,realized_pnl:9.5,fees:0.5 },
      { trade_id:"legacy-open",symbol:"XAUUSD",side:"SELL",quantity:1,
        entry_price:100,stop_loss:110,take_profit:80,status:"OPEN",
        opened_at:"2026-11-25T07:30:00.000Z",fees:0.05 }
    ]
  });
  const first = await stub.getSummary(tokenHash);
  assert.equal(first.balance, 100009.45);
  assert.equal(first.closed_trades, 1);
  assert.equal(first.open_trades, 1);
  assert.equal(first.ledger_events, 3);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.ledger.migration_status, "LEGACY_BACKFILLED");
  assert.equal(integrity.integrity_status, "CLEAN", JSON.stringify(integrity.discrepancies));
  const second = await stub.getSummary(tokenHash);
  assert.equal(second.balance, first.balance);
  assert.equal(second.ledger_events, first.ledger_events);
  assert.equal(await stub.countLedgerRows(), 3);
  assert.equal(integrity.execution_enabled, false);
});

test("partial legacy ledger is never auto-repaired or trusted as account balance", async () => {
  const accountId = "sqlite-partial-ledger";
  const tokenHash = "token-hash-partial-ledger";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.seedPartialLedger({
    accountId, tokenHash, startingCapital: 50000,
    createdAt: "2026-11-25T07:00:00.000Z"
  });
  const rowsBefore = await stub.countLedgerRows();
  const summary = await stub.getSummary(tokenHash);
  assert.equal(summary.balance, 50000);
  assert.equal(summary.ledger_events, 1);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status, "NEEDS_REVIEW");
  assert.equal(integrity.ledger.migration_status, "PARTIAL_UNKNOWN");
  assert.ok(integrity.discrepancies.some(x => x.code === "LEDGER_MIGRATION_INCOMPLETE"));
  assert.equal(await stub.countLedgerRows(), rowsBefore);
  assert.equal(integrity.execution_enabled, false);
});

test("concurrent paper trade retries are idempotent and conflicting payloads are rejected", async () => {
  const accountId = "sqlite-concurrent-idempotency";
  const tokenHash = "token-hash-concurrent-idempotency";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId, tokenHash, "USD", 100000, "2026-11-25T09:00:00.000Z");
  const trade = {
    trade_id: "trade-concurrent-one", symbol: "XAUUSD", side: "BUY",
    quantity: 1, entry_price: 100, stop_loss: 90, take_profit: 120,
    fee_bps: 5, idempotency_key: "idem-concurrent-one"
  };
  const createdAt = "2026-11-25T09:01:00.000Z";
  const [first, second] = await Promise.all([
    stub.createTrade(tokenHash, trade, createdAt),
    stub.createTrade(tokenHash, trade, createdAt)
  ]);
  assert.equal([first, second].filter(x => x.duplicate === false).length, 1);
  assert.equal([first, second].filter(x => x.duplicate === true).length, 1);
  assert.equal((await stub.listTrades(tokenHash)).length, 1);
  const summary = await stub.getSummary(tokenHash);
  assert.equal(summary.ledger_events, 2);
  assert.equal(summary.open_trades, 1);

  const conflicting = { ...trade, quantity: 1.5 };
  const replay = await stub.runCreateTradeWithFault(tokenHash, conflicting, createdAt);
  assert.equal(replay.ok, false);
  assert.match(replay.error, /TRADE_IDEMPOTENCY_CONFLICT/);
  assert.equal((await stub.listTrades(tokenHash)).length, 1);
  assert.equal((await stub.getSummary(tokenHash)).ledger_events, 2);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status, "CLEAN", JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled, false);
});

test("concurrent different idempotency keys cannot open duplicate symbol positions", async () => {
  const accountId = "sqlite-concurrent-symbol-lock";
  const tokenHash = "token-hash-concurrent-symbol-lock";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId, tokenHash, "USD", 100000, "2026-11-25T10:00:00.000Z");
  const makeTrade = (id) => ({
    trade_id: id, symbol: "XAUUSD", side: "BUY", quantity: 1,
    entry_price: 100, stop_loss: 90, take_profit: 120,
    fee_bps: 5, idempotency_key: "idem-" + id
  });
  const results = await Promise.all([
    stub.runCreateTradeWithFault(tokenHash, makeTrade("parallel-a"), "2026-11-25T10:01:00.000Z"),
    stub.runCreateTradeWithFault(tokenHash, makeTrade("parallel-b"), "2026-11-25T10:01:01.000Z")
  ]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(results.filter(x => !x.ok).length, 1);
  assert.match(results.find(x => !x.ok).error, /open paper trade already exists/);
  assert.equal((await stub.listTrades(tokenHash)).length, 1);
  assert.equal((await stub.getSummary(tokenHash)).ledger_events, 2);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status, "CLEAN", JSON.stringify(integrity.discrepancies));
});

test("concurrent close requests settle a paper trade exactly once", async () => {
  const { stub, tokenHash, tradeId } = await makeAccount();
  const [first, second] = await Promise.all([
    stub.closeTrade(tokenHash, tradeId, 110, 5, "2026-11-25T11:02:00.000Z"),
    stub.closeTrade(tokenHash, tradeId, 115, 5, "2026-11-25T11:02:01.000Z")
  ]);
  const results = [first, second];
  assert.equal(results.filter(x => x.status === "CLOSED").length, 1);
  assert.equal(results.filter(x => x.error === "TRADE_NOT_OPEN").length, 1);
  const trades = await stub.listTrades(tokenHash);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, "CLOSED");
  const notifications = await stub.listNotifications(tokenHash);
  assert.equal(notifications.length, 1);
  const summary = await stub.getSummary(tokenHash);
  assert.equal(summary.closed_trades, 1);
  assert.equal(summary.ledger_events, 3);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status, "CLEAN", JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled, false);
});

for (const fault of ["after-close-ledger", "after-close-notification"]) {
  test("SQLite transaction rolls back trade, ledger and notification when failure occurs " + fault, async () => {
    const { stub, tokenHash, tradeId } = await makeAccount();
    const before = await stub.getSummary(tokenHash);
    await stub.setFaultMode(fault);

    const failedClose = await stub.runCloseTradeWithFault(
      tokenHash, tradeId, 110, 5, "2026-11-25T08:02:00.000Z"
    );
    assert.equal(failedClose.ok, false);
    assert.match(failedClose.error, new RegExp(fault === "after-close-ledger"
      ? "INJECTED_FAILURE_AFTER_LEDGER_WRITE"
      : "INJECTED_FAILURE_AFTER_NOTIFICATION_WRITE"));

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
