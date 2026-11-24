import { DurableObject } from "cloudflare:workers";

export class PaperAccount extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency IN ('USD','IRT')),
        starting_capital REAL NOT NULL CHECK(starting_capital > 0),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS creation_limits (
        ip_hash TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        PRIMARY KEY(ip_hash, day)
      );
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance_after REAL NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_trades (
        trade_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
        quantity REAL NOT NULL CHECK(quantity > 0),
        entry_price REAL NOT NULL CHECK(entry_price > 0),
        stop_loss REAL NOT NULL CHECK(stop_loss > 0),
        take_profit REAL NOT NULL CHECK(take_profit > 0),
        status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        exit_price REAL,
        realized_pnl REAL,
        fees REAL NOT NULL DEFAULT 0,
        idempotency_key TEXT UNIQUE
      );
    `);
  }

  allowCreation(ipHash, day) {
    this.ctx.storage.sql.exec("DELETE FROM creation_limits WHERE day < ?", day);
    const rows=this.ctx.storage.sql.exec(
      `INSERT INTO creation_limits(ip_hash,day,count) VALUES(?,?,1)
       ON CONFLICT(ip_hash,day) DO UPDATE SET count=count+1
       WHERE count<3 RETURNING count`,
      ipHash,day
    ).toArray();
    return rows.length===1;
  }

  createAccount(accountId,tokenHash,currency,startingCapital,createdAt) {
    this.ctx.storage.sql.exec(
      `INSERT INTO accounts(account_id,token_hash,currency,starting_capital,created_at)
       VALUES(?,?,?,?,?)`,
      accountId,tokenHash,currency,startingCapital,createdAt
    );
    return {account_id:accountId,currency,starting_capital:startingCapital,
      balance:startingCapital,created_at:createdAt,trading_enabled:false};
  }

  authorizedAccount(tokenHash) {
    return this.ctx.storage.sql.exec(
      `SELECT account_id,currency,starting_capital,created_at
       FROM accounts WHERE token_hash=? LIMIT 1`,
      tokenHash
    ).toArray()[0]??null;
  }

  getSummary(tokenHash) {
    const account=this.authorizedAccount(tokenHash);
    if(!account) return null;
    const ledger=this.ctx.storage.sql.exec(
      "SELECT COALESCE(SUM(amount),0) AS net_ledger_change,COUNT(*) AS ledger_events FROM ledger_entries"
    ).toArray()[0];
    const stats=this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS total_trades,
       SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open_trades,
       SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed_trades,
       COALESCE(SUM(CASE WHEN status='CLOSED' THEN realized_pnl ELSE 0 END),0) AS realized_pnl
       FROM paper_trades`
    ).toArray()[0];
    const realized=Number(stats.realized_pnl||0);
    const balance=account.starting_capital+Number(ledger.net_ledger_change||0)+realized;
    if(!Number.isFinite(balance)) throw new Error("Stored paper balance is invalid");
    return {account_id:account.account_id,currency:account.currency,
      starting_capital:account.starting_capital,balance,realized_pnl:realized,
      total_trades:stats.total_trades||0,open_trades:stats.open_trades||0,
      closed_trades:stats.closed_trades||0,ledger_events:ledger.ledger_events||0,
      created_at:account.created_at,trading_enabled:false,execution_enabled:false};
  }

  listTrades(tokenHash,limit=50) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const safeLimit=Math.max(1,Math.min(Number.isInteger(limit)?limit:50,100));
    return this.ctx.storage.sql.exec(
      `SELECT trade_id,symbol,side,quantity,entry_price,stop_loss,take_profit,
       status,opened_at,closed_at,exit_price,realized_pnl,fees
       FROM paper_trades ORDER BY opened_at DESC LIMIT ?`,
      safeLimit
    ).toArray();
  }
}
