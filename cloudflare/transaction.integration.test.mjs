import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("Durable Object restart recovers paper trades ledger and notifications", async () => {
  const persistencePath = await mkdtemp(join(tmpdir(), "ayyar-do-restart-"));
  const options = {
    scriptPath: "./transaction_test_worker.mjs",
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-07-30",
    durableObjects: {
      PAPER_ACCOUNTS: { className: "FaultInjectPaperAccount", useSQLite: true }
    },
    kvNamespaces: ["SIGNAL_HISTORY"],
    durableObjectsPersist: persistencePath,
    cf: false
  };
  let firstMf;
  try {
    firstMf = new Miniflare(options);
    await firstMf.ready;
    const firstNs = await firstMf.getDurableObjectNamespace("PAPER_ACCOUNTS");
    const accountId = "sqlite-restart-recovery";
    const tokenHash = "token-hash-restart-recovery";
    const firstStub = firstNs.get(firstNs.idFromName(accountId));
    await firstStub.createAccount(accountId,tokenHash,"USD",100000,"2026-11-25T13:00:00.000Z");
    await firstStub.createTrade(tokenHash,{
      trade_id:"restart-closed",symbol:"XAUUSD",side:"BUY",quantity:1,
      entry_price:100,stop_loss:90,take_profit:120,fee_bps:5,
      idempotency_key:"restart-closed-idem"
    },"2026-11-25T13:01:00.000Z");
    await firstStub.closeTrade(tokenHash,"restart-closed",110,5,"2026-11-25T13:02:00.000Z");
    await firstStub.createTrade(tokenHash,{
      trade_id:"restart-open",symbol:"XAGUSD",side:"SELL",quantity:1,
      entry_price:100,stop_loss:110,take_profit:80,fee_bps:5,
      idempotency_key:"restart-open-idem"
    },"2026-11-25T13:03:00.000Z");
    const before = await firstStub.getSummary(tokenHash);
    const expected = {
      balance: Number(before.balance),
      closedTrades: Number(before.closed_trades),
      openTrades: Number(before.open_trades),
      ledgerEvents: Number(before.ledger_events)
    };
    assert.equal(expected.closedTrades,1);
    assert.equal(expected.openTrades,1);
    assert.equal(expected.ledgerEvents,4);
    assert.equal((await firstStub.listNotifications(tokenHash)).length,1);
    // Miniflare restarts its workerd runtime while retaining the configured DO persistence directory.
    // Re-fetch the namespace after setOptions; old stubs are intentionally invalidated.
    await firstMf.setOptions(options);
    const restartedNs = await firstMf.getDurableObjectNamespace("PAPER_ACCOUNTS");
    const recovered = restartedNs.get(restartedNs.idFromName(accountId));
    const after = await recovered.getSummary(tokenHash);
    assert.equal(Number(after.balance),expected.balance);
    assert.equal(after.closed_trades,1);
    assert.equal(after.open_trades,1);
    assert.equal(after.ledger_events,4);
    const trades = await recovered.listTrades(tokenHash);
    assert.equal(trades.length,2);
    assert.equal(trades.filter(x=>x.status==="CLOSED").length,1);
    assert.equal(trades.filter(x=>x.status==="OPEN").length,1);
    assert.equal((await recovered.listNotifications(tokenHash)).length,1);
    const integrity = await recovered.getIntegrityReport(tokenHash);
    assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
    assert.equal(integrity.execution_enabled,false);
  } finally {
    await firstMf?.dispose();
    await rm(persistencePath,{recursive:true,force:true});
  }
});

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
  assert.equal(await stub.getTradeFeeRate("legacy-open"), 5);
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

test("single-trade risk accepts the exact one percent boundary and rejects any excess", async () => {
  const acceptedId = "sqlite-risk-one-percent-boundary";
  const acceptedToken = "token-hash-risk-one-percent-boundary";
  const accepted = namespace.get(namespace.idFromName(acceptedId));
  await accepted.createAccount(acceptedId,acceptedToken,"USD",100000,"2026-11-25T06:00:00.000Z");
  const atLimit = await accepted.createTrade(acceptedToken,{
    trade_id:"risk-exact-one-percent",symbol:"XAUUSD",side:"BUY",quantity:100,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:0,
    idempotency_key:"idem-risk-exact-one-percent"
  },"2026-11-25T06:01:00.000Z");
  assert.equal(atLimit.status,"OPEN");
  assert.equal((await accepted.getIntegrityReport(acceptedToken)).integrity_status,"CLEAN");

  const rejectedId = "sqlite-risk-over-one-percent";
  const rejectedToken = "token-hash-risk-over-one-percent";
  const rejected = namespace.get(namespace.idFromName(rejectedId));
  await rejected.createAccount(rejectedId,rejectedToken,"USD",100000,"2026-11-25T06:00:00.000Z");
  const overLimit = await rejected.runCreateTradeWithFault(rejectedToken,{
    trade_id:"risk-over-one-percent",symbol:"XAGUSD",side:"BUY",quantity:100.01,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:0,
    idempotency_key:"idem-risk-over-one-percent"
  },"2026-11-25T06:01:00.000Z");
  assert.equal(overLimit.ok,false);
  assert.match(overLimit.error,/RISK_LIMIT_EXCEEDED/);
  assert.equal((await rejected.listTrades(rejectedToken)).length,0);
  const summary = await rejected.getSummary(rejectedToken);
  assert.equal(summary.balance,100000);
  assert.equal(summary.ledger_events,1);
  const integrity = await rejected.getIntegrityReport(rejectedToken);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled,false);
});

test("single-trade risk boundary includes both entry and stop-loss fees", async () => {
  const acceptedId="sqlite-fee-aware-risk-accepted";
  const acceptedToken="token-hash-fee-aware-risk-accepted";
  const accepted=namespace.get(namespace.idFromName(acceptedId));
  await accepted.createAccount(acceptedId,acceptedToken,"USD",100000,"2026-11-25T06:00:00.000Z");
  const within=await accepted.createTrade(acceptedToken,{
    trade_id:"fee-aware-risk-within",symbol:"XAUUSD",side:"BUY",quantity:99.05,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:5,
    idempotency_key:"idem-fee-aware-risk-within"
  },"2026-11-25T06:01:00.000Z");
  assert.equal(within.status,"OPEN");

  const rejectedId="sqlite-fee-aware-risk-rejected";
  const rejectedToken="token-hash-fee-aware-risk-rejected";
  const rejected=namespace.get(namespace.idFromName(rejectedId));
  await rejected.createAccount(rejectedId,rejectedToken,"USD",100000,"2026-11-25T06:00:00.000Z");
  const over=await rejected.runCreateTradeWithFault(rejectedToken,{
    trade_id:"fee-aware-risk-over",symbol:"XAGUSD",side:"BUY",quantity:99.06,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:5,
    idempotency_key:"idem-fee-aware-risk-over"
  },"2026-11-25T06:01:00.000Z");
  assert.equal(over.ok,false);
  assert.match(over.error,/RISK_LIMIT_EXCEEDED/);
  assert.equal((await rejected.listTrades(rejectedToken)).length,0);
  const integrity=await rejected.getIntegrityReport(rejectedToken);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled,false);
});

test("aggregate open risk is capped at two percent of paper equity", async () => {
  const accountId = "sqlite-aggregate-risk";
  const tokenHash = "token-hash-aggregate-risk";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId, tokenHash, "USD", 100000, "2026-11-25T06:00:00.000Z");
  const makeTrade = (id,symbol) => ({
    trade_id:id,symbol,side:"BUY",quantity:100,entry_price:100,
    stop_loss:90,take_profit:120,fee_bps:0,idempotency_key:"idem-"+id
  });
  const first = await stub.createTrade(tokenHash,makeTrade("risk-one","XAUUSD"),"2026-11-25T06:01:00.000Z");
  const second = await stub.createTrade(tokenHash,makeTrade("risk-two","XAGUSD"),"2026-11-25T06:02:00.000Z");
  assert.equal(first.status,"OPEN");
  assert.equal(second.status,"OPEN");
  const third = await stub.runCreateTradeWithFault(tokenHash,makeTrade("risk-three","EURUSD"),"2026-11-25T06:03:00.000Z");
  assert.equal(third.ok,false);
  assert.match(third.error,/TOTAL_OPEN_RISK_LIMIT_EXCEEDED/);
  assert.equal((await stub.listTrades(tokenHash)).length,2);
  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
});

test("daily realized loss limit blocks new paper positions", async () => {
  const accountId = "sqlite-daily-loss-limit";
  const tokenHash = "token-hash-daily-loss-limit";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId,tokenHash,"USD",100000,"2026-11-25T05:00:00.000Z");
  for (let i=0;i<4;i++) {
    const id="daily-loss-"+i, symbol=["XAUUSD","XAGUSD","EURUSD","GBPUSD"][i];
    const trade={trade_id:id,symbol,side:"BUY",quantity:80,entry_price:100,
      stop_loss:90,take_profit:120,fee_bps:0,idempotency_key:"idem-"+id};
    await stub.createTrade(tokenHash,trade,"2026-11-25T05:0"+(i+1)+":00.000Z");
    const closed=await stub.closeTrade(tokenHash,id,90,0,"2026-11-25T05:1"+i+":00.000Z");
    assert.equal(closed.status,"CLOSED");
  }
  const blocked=await stub.runCreateTradeWithFault(tokenHash,{
    trade_id:"after-daily-limit",symbol:"USDJPY",side:"BUY",quantity:1,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:0,
    idempotency_key:"idem-after-daily-limit"
  },"2026-11-25T05:59:00.000Z");
  assert.equal(blocked.ok,false);
  assert.match(blocked.error,/DAILY_LOSS_LIMIT_EXCEEDED/);
  assert.equal((await stub.getSummary(tokenHash)).closed_trades,4);
  assert.equal((await stub.getIntegrityReport(tokenHash)).integrity_status,"CLEAN");
});

test("eight percent peak-to-current drawdown blocks new paper positions", async () => {
  const accountId = "sqlite-max-drawdown";
  const tokenHash = "token-hash-max-drawdown";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId,tokenHash,"USD",100000,"2026-11-01T00:00:00.000Z");
  for (let i=0;i<10;i++) {
    const day=String(i+1).padStart(2,"0");
    const opened="2026-11-"+day+"T09:00:00.000Z";
    const closedAt="2026-11-"+day+"T10:00:00.000Z";
    const id="drawdown-"+i;
    await stub.createTrade(tokenHash,{
      trade_id:id,symbol:"XAUUSD",side:"BUY",quantity:80,entry_price:100,
      stop_loss:90,take_profit:120,fee_bps:0,idempotency_key:"idem-"+id
    },opened);
    const closed=await stub.closeTrade(tokenHash,id,90,0,closedAt);
    assert.equal(closed.status,"CLOSED");
  }
  const blocked=await stub.runCreateTradeWithFault(tokenHash,{
    trade_id:"after-drawdown-limit",symbol:"XAUUSD",side:"BUY",quantity:1,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:0,
    idempotency_key:"idem-after-drawdown-limit"
  },"2026-11-11T09:00:00.000Z");
  assert.equal(blocked.ok,false);
  assert.match(blocked.error,/MAX_DRAWDOWN_LIMIT_EXCEEDED/);
  assert.equal((await stub.getSummary(tokenHash)).balance,92000);
  const integrity=await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
});

test("full paper lifecycle settles take-profit and stop-loss once and reconciles reports and ledger", async () => {
  const accountId = "sqlite-full-paper-lifecycle";
  const tokenHash = "token-hash-full-paper-lifecycle";
  const stub = namespace.get(namespace.idFromName(accountId));
  const openedAt = "2026-11-25T08:00:00.000Z";
  await stub.createAccount(accountId,tokenHash,"USD",100000,openedAt);

  const takeProfitTrade = {
    trade_id:"lifecycle-take-profit",symbol:"XAUUSD",side:"BUY",quantity:1,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:5,
    idempotency_key:"lifecycle-take-profit-idem"
  };
  const stopLossTrade = {
    trade_id:"lifecycle-stop-loss",symbol:"XAGUSD",side:"SELL",quantity:1,
    entry_price:100,stop_loss:110,take_profit:80,fee_bps:5,
    idempotency_key:"lifecycle-stop-loss-idem"
  };
  const firstOpen = await stub.createTrade(tokenHash,takeProfitTrade,"2026-11-25T08:01:00.000Z");
  const secondOpen = await stub.createTrade(tokenHash,stopLossTrade,"2026-11-25T08:02:00.000Z");
  assert.equal(firstOpen.status,"OPEN");
  assert.equal(secondOpen.status,"OPEN");
  assert.equal((await stub.getSummary(tokenHash)).ledger_events,3);

  const noExit = await stub.monitorTrades(tokenHash,"XAUUSD",{
    timestamp:"2026-11-25T08:15:00.000Z",open:100,high:115,low:95,close:110
  },5,"2026-11-25T08:16:00.000Z");
  assert.equal(noExit.closed,0);
  assert.equal(noExit.results[0].status,"OPEN");

  const takeProfit = await stub.monitorTrades(tokenHash,"XAUUSD",{
    timestamp:"2026-11-25T08:30:00.000Z",open:110,high:121,low:105,close:120
  },5,"2026-11-25T08:31:00.000Z");
  assert.equal(takeProfit.closed,1);
  assert.equal(takeProfit.results[0].status,"CLOSED");
  assert.equal(Number(takeProfit.results[0].exit_price),120);

  const stopLoss = await stub.monitorTrades(tokenHash,"XAGUSD",{
    timestamp:"2026-11-25T08:15:00.000Z",open:100,high:111,low:95,close:105
  },5,"2026-11-25T08:16:00.000Z");
  assert.equal(stopLoss.closed,1);
  assert.equal(stopLoss.results[0].status,"CLOSED");
  assert.equal(Number(stopLoss.results[0].exit_price),110);

  const repeatedTakeProfit = await stub.monitorTrades(tokenHash,"XAUUSD",{
    timestamp:"2026-11-25T08:30:00.000Z",open:110,high:121,low:105,close:120
  },5,"2026-11-25T08:32:00.000Z");
  assert.equal(repeatedTakeProfit.closed,0);
  assert.equal((await stub.closeTrade(tokenHash,takeProfitTrade.trade_id,120,5,
    "2026-11-25T08:33:00.000Z")).error,"TRADE_NOT_OPEN");

  const trades = await stub.listTrades(tokenHash);
  assert.equal(trades.length,2);
  assert.ok(trades.every(trade=>trade.status==="CLOSED"));
  const notifications = await stub.listNotifications(tokenHash);
  assert.equal(notifications.length,2);
  assert.equal(new Set(notifications.map(item=>item.trade_id)).size,2);

  const summary = await stub.getSummary(tokenHash);
  assert.equal(summary.open_trades,0);
  assert.equal(summary.closed_trades,2);
  assert.equal(summary.ledger_events,5);
  assert.ok(Math.abs(Number(summary.balance)-100009.785)<1e-8);
  assert.ok(Math.abs(Number(summary.realized_pnl)-9.785)<1e-8);

  const daily = await stub.getDailyReport(tokenHash,"2026-11-25");
  assert.equal(daily.closed_trades,2);
  assert.equal(daily.wins,1);
  assert.equal(daily.losses,1);
  assert.ok(Math.abs(daily.realized_pnl-9.785)<1e-8);
  assert.ok(Math.abs(daily.fees-0.215)<1e-8);

  const performance = await stub.getPerformanceReport(tokenHash,"week","2026-11-25");
  assert.equal(performance.closed_trades,2);
  assert.equal(performance.wins,1);
  assert.equal(performance.losses,1);
  assert.ok(Math.abs(performance.net_pnl-9.785)<1e-8);
  assert.ok(Math.abs(performance.ending_balance-100009.785)<1e-8);
  assert.equal(performance.execution_enabled,false);

  const integrity = await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.trades.total,2);
  assert.equal(integrity.trades.closed,2);
  assert.equal(integrity.ledger.events,5);
  assert.equal(integrity.execution_enabled,false);
});

test("stress: 30 concurrent create and close retries settle exactly once", async () => {
  const accountId = "sqlite-stress-retries";
  const tokenHash = "token-hash-stress-retries";
  const stub = namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId,tokenHash,"USD",100000,"2026-11-25T12:00:00.000Z");
  const trade = {
    trade_id:"stress-trade",symbol:"XAUUSD",side:"BUY",quantity:1,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:5,
    idempotency_key:"stress-idem"
  };
  const createdAt="2026-11-25T12:01:00.000Z";
  const creates=await Promise.all(Array.from({length:30},()=>stub.createTrade(tokenHash,trade,createdAt)));
  assert.equal(creates.filter(x=>x.duplicate===false).length,1);
  assert.equal(creates.filter(x=>x.duplicate===true).length,29);
  assert.equal((await stub.listTrades(tokenHash)).length,1);
  assert.equal((await stub.getSummary(tokenHash)).ledger_events,2);

  const closes=await Promise.all(Array.from({length:30},(_,i)=>
    stub.closeTrade(tokenHash,"stress-trade",110+i,5,
      "2026-11-25T12:"+(String(2+Math.floor(i/60)).padStart(2,"0"))+":"+String(i%60).padStart(2,"0")+".000Z")
  ));
  assert.equal(closes.filter(x=>x.status==="CLOSED").length,1);
  assert.equal(closes.filter(x=>x.error==="TRADE_NOT_OPEN").length,29);
  assert.equal((await stub.listTrades(tokenHash)).filter(x=>x.status==="CLOSED").length,1);
  assert.equal((await stub.listNotifications(tokenHash)).length,1);
  const summary=await stub.getSummary(tokenHash);
  assert.equal(summary.closed_trades,1);
  assert.equal(summary.ledger_events,3);
  const integrity=await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled,false);
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


test("same signal cannot open a second paper trade with a different idempotency key", async () => {
  const accountId="sqlite-signal-idempotency";
  const tokenHash="token-hash-signal-idempotency";
  const stub=namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId,tokenHash,"USD",100000,"2026-11-25T09:00:00.000Z");
  const firstTrade={
    trade_id:"signal-trade-first",symbol:"XAUUSD",side:"BUY",quantity:1,
    entry_price:100,stop_loss:90,take_profit:120,fee_bps:5,
    idempotency_key:"signal-idem-first",strategy_id:"ema-atr",
    signal_id:"sha256:signal-fingerprint-001",signal_type:"BUY"
  };
  const [first,second]=await Promise.all([
    stub.createTrade(tokenHash,firstTrade,"2026-11-25T09:01:00.000Z"),
    stub.createTrade(tokenHash,{...firstTrade,trade_id:"signal-trade-second",
      idempotency_key:"signal-idem-second"},"2026-11-25T09:01:02.000Z")
  ]);
  assert.equal([first,second].filter(x=>x.duplicate===false).length,1);
  assert.equal([first,second].filter(x=>x.duplicate===true).length,1);
  assert.equal(first.trade_id,second.trade_id);
  assert.equal((await stub.listTrades(tokenHash)).length,1);
  assert.equal((await stub.getSummary(tokenHash)).ledger_events,2);

  const conflict=await stub.runCreateTradeWithFault(tokenHash,{
    ...firstTrade,trade_id:"signal-trade-conflict",idempotency_key:"signal-idem-conflict",
    entry_price:101
  },"2026-11-25T09:02:00.000Z");
  assert.equal(conflict.ok,false);
  assert.match(conflict.error,/SIGNAL_ALREADY_PROCESSED_WITH_DIFFERENT_TRADE/);
  assert.equal((await stub.listTrades(tokenHash)).length,1);
  const integrity=await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled,false);
});


test("paper trades reject missing, non-directional, or side-mismatched signal metadata", async () => {
  const accountId="sqlite-invalid-signal-metadata";
  const tokenHash="token-hash-invalid-signal-metadata";
  const stub=namespace.get(namespace.idFromName(accountId));
  await stub.createAccount(accountId,tokenHash,"USD",100000,"2026-11-27T09:00:00.000Z");
  const base={symbol:"XAUUSD",side:"BUY",quantity:1,entry_price:100,
    stop_loss:90,take_profit:120,fee_bps:5};
  const invalid=[
    {...base,trade_id:"missing-type",signal_id:"fingerprint-missing-type"},
    {...base,trade_id:"missing-id",signal_type:"BUY"},
    {...base,trade_id:"no-trade",signal_id:"fingerprint-no-trade",signal_type:"NO_TRADE"},
    {...base,trade_id:"wrong-side",signal_id:"fingerprint-wrong-side",signal_type:"SELL"}
  ];
  for(let i=0;i<invalid.length;i++){
    assert.throws(
      () => stub.createTrade(tokenHash,{...invalid[i],idempotency_key:"invalid-signal-"+i},
        "2026-11-27T09:01:0"+i+".000Z"),
      /INVALID_SIGNAL_TRADE_METADATA/
    );
  }
  assert.equal((await stub.listTrades(tokenHash)).length,0);
  assert.equal((await stub.getSummary(tokenHash)).ledger_events,1);
  const integrity=await stub.getIntegrityReport(tokenHash);
  assert.equal(integrity.integrity_status,"CLEAN",JSON.stringify(integrity.discrepancies));
  assert.equal(integrity.execution_enabled,false);
});
