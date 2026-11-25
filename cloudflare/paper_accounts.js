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
        idempotency_key TEXT UNIQUE,
        last_checked_at TEXT
      );
    `);
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN last_checked_at TEXT"); } catch {}
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
    const openFees=this.ctx.storage.sql.exec("SELECT COALESCE(SUM(fees),0) AS amount FROM paper_trades WHERE status='OPEN'").toArray()[0];
    const balance=account.starting_capital+Number(ledger.net_ledger_change||0)+realized-Number(openFees.amount||0);
    if(!Number.isFinite(balance)) throw new Error("Stored paper balance is invalid");
    return {account_id:account.account_id,currency:account.currency,
      starting_capital:account.starting_capital,balance,realized_pnl:realized,
      total_trades:stats.total_trades||0,open_trades:stats.open_trades||0,
      closed_trades:stats.closed_trades||0,ledger_events:ledger.ledger_events||0,
      created_at:account.created_at,trading_enabled:false,execution_enabled:false};
  }

  createTrade(tokenHash,trade,createdAt) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const existing=trade.idempotency_key ? this.ctx.storage.sql.exec(
      "SELECT trade_id,status FROM paper_trades WHERE idempotency_key=? LIMIT 1",
      trade.idempotency_key
    ).toArray()[0] : null;
    if(existing) return { ...existing, duplicate:true };
    const summary=this.getSummary(tokenHash);
    const open=this.ctx.storage.sql.exec("SELECT COALESCE(SUM(quantity*entry_price),0) AS exposure FROM paper_trades WHERE status='OPEN'").toArray()[0];
    const notional=trade.quantity*trade.entry_price;
    const risk=trade.quantity*Math.abs(trade.entry_price-trade.stop_loss);
    if(!Number.isFinite(notional)||notional<=0||notional+Number(open.exposure||0)>summary.balance)
      throw new Error("INSUFFICIENT_PAPER_BALANCE");
    if(!Number.isFinite(risk)||risk>summary.balance*0.01+1e-8)
      throw new Error("RISK_LIMIT_EXCEEDED");
    const entryFee=notional*trade.fee_bps/10000;
    this.ctx.storage.sql.exec(
      `INSERT INTO paper_trades
       (trade_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status,opened_at,fees,idempotency_key)
       VALUES(?,?,?,?,?,?,?,'OPEN',?,?,?)`,
      trade.trade_id,trade.symbol,trade.side,trade.quantity,trade.entry_price,
      trade.stop_loss,trade.take_profit,createdAt,entryFee,trade.idempotency_key
    );
    return {trade_id:trade.trade_id,symbol:trade.symbol,side:trade.side,quantity:trade.quantity,
      entry_price:trade.entry_price,stop_loss:trade.stop_loss,take_profit:trade.take_profit,
      status:"OPEN",opened_at:createdAt,fees:entryFee,duplicate:false,execution_enabled:false};
  }

  closeTrade(tokenHash,tradeId,exitPrice,feeBps,closedAt) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const trade=this.ctx.storage.sql.exec("SELECT * FROM paper_trades WHERE trade_id=? AND status='OPEN' LIMIT 1",tradeId).toArray()[0];
    if(!trade) return {error:"TRADE_NOT_OPEN"};
    const direction=trade.side==="BUY"?1:-1;
    const gross=(exitPrice-trade.entry_price)*trade.quantity*direction;
    const exitFee=exitPrice*trade.quantity*feeBps/10000;
    const entryFee=Number(trade.fees||0);
    const fees=entryFee+exitFee;
    const realized=gross-fees;
    if(![gross,exitFee,entryFee,fees,realized].every(Number.isFinite)) throw new Error("TRADE_VALUE_OUT_OF_RANGE");
    const updated=this.ctx.storage.sql.exec(
      `UPDATE paper_trades SET status='CLOSED',closed_at=?,exit_price=?,realized_pnl=?,fees=?
       WHERE trade_id=? AND status='OPEN'
       RETURNING trade_id,status,exit_price,realized_pnl,fees,closed_at`,
      closedAt,exitPrice,realized,fees,tradeId
    ).toArray()[0];
    return updated??{error:"TRADE_NOT_OPEN"};
  }
  monitorTrades(tokenHash,candle,feeBps,checkedAt) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const rows=this.ctx.storage.sql.exec(
      "SELECT * FROM paper_trades WHERE status='OPEN' ORDER BY opened_at ASC"
    ).toArray();
    const results=[];
    for(const trade of rows) {
      if(trade.last_checked_at && trade.last_checked_at>=candle.timestamp) {
        results.push({trade_id:trade.trade_id,status:"UNCHANGED",reason:"CANDLE_ALREADY_PROCESSED"});
        continue;
      }
      const isBuy=trade.side==="BUY";
      const stopHit=isBuy?candle.low<=trade.stop_loss:candle.high>=trade.stop_loss;
      const targetHit=isBuy?candle.high>=trade.take_profit:candle.low<=trade.take_profit;
      let exitPrice=null,reason=null;
      // Conservative same-candle rule: stop takes precedence over target.
      if(stopHit) {
        reason="STOP_LOSS";
        exitPrice=isBuy&&candle.open<trade.stop_loss?candle.open:
          !isBuy&&candle.open>trade.stop_loss?candle.open:trade.stop_loss;
      } else if(targetHit) {
        reason="TAKE_PROFIT";
        exitPrice=isBuy&&candle.open>trade.take_profit?trade.take_profit:
          !isBuy&&candle.open<trade.take_profit?trade.take_profit:trade.take_profit;
      }
      if(exitPrice!==null) {
        const direction=isBuy?1:-1;
        const gross=(exitPrice-trade.entry_price)*trade.quantity*direction;
        const exitFee=exitPrice*trade.quantity*feeBps/10000;
        const fees=Number(trade.fees||0)+exitFee;
        const realized=gross-fees;
        if(![gross,exitFee,fees,realized].every(Number.isFinite))
          throw new Error("TRADE_VALUE_OUT_OF_RANGE");
        const closed=this.ctx.storage.sql.exec(
          `UPDATE paper_trades SET status='CLOSED',closed_at=?,exit_price=?,realized_pnl=?,fees=?,last_checked_at=?
           WHERE trade_id=? AND status='OPEN'
           RETURNING trade_id,status,exit_price,realized_pnl,fees,closed_at`,
          checkedAt,exitPrice,realized,fees,candle.timestamp,trade.trade_id
        ).toArray()[0];
        results.push({...closed,exit_reason:reason});
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE paper_trades SET last_checked_at=? WHERE trade_id=? AND status='OPEN'",
          candle.timestamp,trade.trade_id
        );
        results.push({trade_id:trade.trade_id,status:"OPEN",checked_candle_at:candle.timestamp});
      }
    }
    return {checked_candle_at:candle.timestamp,checked_at:checkedAt,processed:results.length,
      closed:results.filter(x=>x.status==="CLOSED").length,results,execution_enabled:false};
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
