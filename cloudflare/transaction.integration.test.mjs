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
