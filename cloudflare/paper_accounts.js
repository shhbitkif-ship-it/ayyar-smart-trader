import { DurableObject } from "cloudflare:workers";
import { calculateLegacyPaperBalance, calculatePaperEntryFee, calculatePaperSettlement, ledgerEventReplayMatches } from "./ledger_math.mjs";

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
      CREATE TABLE IF NOT EXISTS account_registry (
        account_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS ledger_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        status TEXT NOT NULL CHECK(status IN ('READY','LEGACY_BACKFILLED','PARTIAL_UNKNOWN')),
        initialized_at TEXT NOT NULL
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
        fee_bps REAL NOT NULL DEFAULT 0,
        idempotency_key TEXT UNIQUE,
        last_checked_at TEXT,
        strategy_id TEXT,
        signal_id TEXT,
        signal_type TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_notifications (
        notification_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        realized_pnl REAL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_notifications_created
        ON paper_notifications(created_at DESC);
    `);
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN fee_bps REAL NOT NULL DEFAULT 0"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN last_checked_at TEXT"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN strategy_id TEXT"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN signal_id TEXT"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN signal_type TEXT"); } catch {}
    // Legacy rows did not persist fee_bps. Infer a conservative rate from the recorded entry fee.
    this.ctx.storage.sql.exec(
      "UPDATE paper_trades SET fee_bps=MIN(1000,fees*10000/(quantity*entry_price)) WHERE fee_bps=0 AND fees>0 AND quantity>0 AND entry_price>0"
    );
  }

  registerAccount(accountId, createdAt) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO account_registry(account_id,created_at) VALUES(?,?)",
      accountId,createdAt
    );
    return {registered:true,account_id:accountId};
  }

  listAccountIds(limit=5000) {
    const safeLimit=Math.max(1,Math.min(Number.isInteger(limit)?limit:5000,5000));
    return this.ctx.storage.sql.exec(
      "SELECT account_id FROM account_registry ORDER BY created_at ASC LIMIT ?",
      safeLimit
    ).toArray().map(row=>row.account_id);
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
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec(
        `INSERT INTO accounts(account_id,token_hash,currency,starting_capital,created_at)
         VALUES(?,?,?,?,?)`,
        accountId,tokenHash,currency,startingCapital,createdAt
      );
      this._appendLedgerEntry({account_id:accountId,starting_capital:startingCapital},
        "ACCOUNT_OPENED:"+accountId,"ACCOUNT_OPENED",startingCapital,
        {account_id:accountId},createdAt);
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger_state(id,status,initialized_at) VALUES(1,'READY',?)",createdAt
      );
    });
    return {account_id:accountId,currency,starting_capital:startingCapital,
      balance:startingCapital,created_at:createdAt,trading_enabled:false};
  }

  authorizedAccount(tokenHash) {
    return this.ctx.storage.sql.exec(
      `SELECT account_id,token_hash,currency,starting_capital,created_at
       FROM accounts WHERE token_hash=? LIMIT 1`,
      tokenHash
    ).toArray()[0]??null;
  }

  _appendLedgerEntry(account,eventId,eventType,amount,metadata,createdAt) {
    if(typeof eventId!=="string"||!eventId||typeof eventType!=="string"||!eventType||
      !Number.isFinite(amount)||!metadata||typeof metadata!=="object"||Array.isArray(metadata)||
      typeof createdAt!=="string"||!Number.isFinite(Date.parse(createdAt)))
      throw new Error("INVALID_LEDGER_EVENT");
    const existing=this.ctx.storage.sql.exec(
      "SELECT event_type,amount,metadata_json,created_at FROM ledger_entries WHERE event_id=? LIMIT 1",eventId
    ).toArray()[0];
    if(existing) {
      if(!ledgerEventReplayMatches(existing,{eventType,amount,metadata,createdAt}))
        throw new Error("LEDGER_IDEMPOTENCY_CONFLICT");
      return false;
    }
    const last=this.ctx.storage.sql.exec(
      "SELECT balance_after FROM ledger_entries ORDER BY id DESC LIMIT 1"
    ).toArray()[0];
    const before=last?Number(last.balance_after):0;
    const after=before+amount;
    if(!Number.isFinite(before)||!Number.isFinite(after)) throw new Error("LEDGER_BALANCE_OUT_OF_RANGE");
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger_entries(event_id,event_type,amount,balance_after,metadata_json,created_at)
       VALUES(?,?,?,?,?,?)`,
      eventId,eventType,amount,after,JSON.stringify(metadata),createdAt
    );
    return true;
  }

  _ensureLedgerInitialized(account) {
    // Apply the legacy fee-rate migration after any pre-existing rows are visible.
    this.ctx.storage.sql.exec(
      "UPDATE paper_trades SET fee_bps=MIN(1000,fees*10000/(quantity*entry_price)) WHERE fee_bps=0 AND fees>0 AND quantity>0 AND entry_price>0"
    );
    const state=this.ctx.storage.sql.exec("SELECT status FROM ledger_state WHERE id=1").toArray()[0];
    if(state) return state.status;
    return this.ctx.storage.transactionSync(()=>{
      const current=this.ctx.storage.sql.exec("SELECT status FROM ledger_state WHERE id=1").toArray()[0];
      if(current) return current.status;
      const existing=this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM ledger_entries").toArray()[0];
      if(Number(existing.count||0)>0) {
        this.ctx.storage.sql.exec(
          "INSERT INTO ledger_state(id,status,initialized_at) VALUES(1,'PARTIAL_UNKNOWN',?)",
          new Date().toISOString()
        );
        return "PARTIAL_UNKNOWN";
      }
      this._appendLedgerEntry(account,"ACCOUNT_OPENED:"+account.account_id,"ACCOUNT_OPENED",
        Number(account.starting_capital),{account_id:account.account_id,legacy_backfill:true},account.created_at);
      const trades=this.ctx.storage.sql.exec(
        "SELECT trade_id,symbol,side,quantity,entry_price,status,opened_at,closed_at,realized_pnl,fees FROM paper_trades ORDER BY opened_at ASC"
      ).toArray();
      const events=[];
      for(const trade of trades) {
        if(trade.status==="OPEN"&&Number.isFinite(Number(trade.fees))&&Number(trade.fees)>=0&&
          Number.isFinite(Date.parse(trade.opened_at||""))) {
          events.push({id:"TRADE_OPENED:"+trade.trade_id,type:"TRADE_OPENED",
            amount:-Number(trade.fees),at:trade.opened_at,
            metadata:{trade_id:trade.trade_id,legacy_backfill:true}});
        } else if(trade.status==="CLOSED"&&Number.isFinite(Number(trade.realized_pnl))&&
          Number.isFinite(Date.parse(trade.closed_at||""))) {
          events.push({id:"TRADE_CLOSED:"+trade.trade_id,type:"TRADE_CLOSED",
            amount:Number(trade.realized_pnl),at:trade.closed_at,
            metadata:{trade_id:trade.trade_id,legacy_backfill:true}});
        }
      }
      events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));
      for(const event of events)
        this._appendLedgerEntry(account,event.id,event.type,event.amount,event.metadata,event.at);
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger_state(id,status,initialized_at) VALUES(1,'LEGACY_BACKFILLED',?)",
        new Date().toISOString()
      );
      return "LEGACY_BACKFILLED";
    });
  }

  getSummary(tokenHash) {
    const account=this.authorizedAccount(tokenHash);
    if(!account) return null;
    const ledgerStatus=this._ensureLedgerInitialized(account);
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
    // PARTIAL_UNKNOWN may contain only a subset of historical events. Exclude it
    // from the legacy balance to avoid counting realized PnL twice.
    const legacyBalance=calculateLegacyPaperBalance({startingCapital:Number(account.starting_capital),
      realizedPnl:realized,openFees:Number(openFees.amount||0)});
    const balance=ledgerStatus==="PARTIAL_UNKNOWN"?legacyBalance:Number(ledger.net_ledger_change||0);
    if(!Number.isFinite(balance)) throw new Error("Stored paper balance is invalid");
    return {account_id:account.account_id,currency:account.currency,
      starting_capital:account.starting_capital,balance,realized_pnl:realized,
      total_trades:stats.total_trades||0,open_trades:stats.open_trades||0,
      closed_trades:stats.closed_trades||0,ledger_events:ledger.ledger_events||0,
      created_at:account.created_at,trading_enabled:false,execution_enabled:false};
  }

  getIntegrityReport(tokenHash) {
    const account=this.authorizedAccount(tokenHash);
    if(!account) return null;
    const ledgerStatus=this._ensureLedgerInitialized(account);
    const discrepancies=[];
    const tolerance=1e-8;
    const closeEnough=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&
      Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b));
    const ledgerRows=this.ctx.storage.sql.exec(
      "SELECT id,event_id,event_type,amount,balance_after,metadata_json,created_at FROM ledger_entries ORDER BY id ASC"
    ).toArray();
    const trades=this.ctx.storage.sql.exec(
      "SELECT trade_id,symbol,side,quantity,entry_price,status,opened_at,closed_at,exit_price,realized_pnl,fees FROM paper_trades ORDER BY opened_at ASC"
    ).toArray();
    const notifications=this.ctx.storage.sql.exec(
      "SELECT trade_id,event_type,COUNT(*) AS event_count FROM paper_notifications GROUP BY trade_id,event_type"
    ).toArray();
    const notificationCounts=new Map(notifications.map(row=>[row.trade_id+":"+row.event_type,Number(row.event_count||0)]));
    let ledgerChange=0,ledgerBalance=0;
    const ledgerByEvent=new Map(ledgerRows.map(row=>[row.event_id,row]));
    const accountEvent=ledgerByEvent.get("ACCOUNT_OPENED:"+account.account_id);
    if(!accountEvent||accountEvent.event_type!=="ACCOUNT_OPENED"||
      !closeEnough(Number(accountEvent.amount),Number(account.starting_capital)))
      discrepancies.push({code:"ACCOUNT_OPENING_LEDGER_EVENT_MISSING_OR_INVALID"});
    for(const row of ledgerRows) {
      const amount=Number(row.amount),balanceAfter=Number(row.balance_after);
      let metadataValid=false;
      try { const metadata=JSON.parse(row.metadata_json); metadataValid=Boolean(metadata&&typeof metadata==="object"&&!Array.isArray(metadata)); } catch {}
      if(typeof row.event_id!=="string"||!row.event_id||typeof row.event_type!=="string"||!row.event_type||
        !Number.isFinite(amount)||!Number.isFinite(balanceAfter)||!metadataValid||
        typeof row.created_at!=="string"||!Number.isFinite(Date.parse(row.created_at))) {
        discrepancies.push({code:"INVALID_LEDGER_ENTRY",ledger_id:row.id});
        continue;
      }
      ledgerChange+=amount;
      ledgerBalance+=amount;
      if(!closeEnough(balanceAfter,ledgerBalance))
        discrepancies.push({code:"LEDGER_BALANCE_AFTER_MISMATCH",ledger_id:row.id,
          expected_balance_after:ledgerBalance,recorded_balance_after:balanceAfter});
    }
    let realizedPnl=0,openFees=0,closedTrades=0,openTrades=0;
    for(const trade of trades) {
      const quantity=Number(trade.quantity),entry=Number(trade.entry_price),fees=Number(trade.fees);
      if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(entry)||entry<=0||
        !Number.isFinite(fees)||fees<0||!["BUY","SELL"].includes(trade.side)||
        typeof trade.trade_id!=="string"||!trade.trade_id||
        !Number.isFinite(Date.parse(trade.opened_at||""))) {
        discrepancies.push({code:"INVALID_TRADE_RECORD",trade_id:trade.trade_id??null});
        continue;
      }
      if(trade.status==="OPEN") {
        openTrades++;
        openFees+=fees;
        if(trade.closed_at!==null||trade.exit_price!==null||trade.realized_pnl!==null)
          discrepancies.push({code:"OPEN_TRADE_HAS_CLOSING_FIELDS",trade_id:trade.trade_id});
        const openEvent=ledgerByEvent.get("TRADE_OPENED:"+trade.trade_id);
        if(!openEvent||openEvent.event_type!=="TRADE_OPENED"||
          !closeEnough(Number(openEvent.amount),-fees))
          discrepancies.push({code:"TRADE_OPEN_LEDGER_EVENT_MISSING_OR_INVALID",trade_id:trade.trade_id});
        if(notificationCounts.get(trade.trade_id+":TRADE_CLOSED")>0)
          discrepancies.push({code:"OPEN_TRADE_HAS_CLOSE_NOTIFICATION",trade_id:trade.trade_id});
      } else if(trade.status==="CLOSED") {
        closedTrades++;
        const exit=Number(trade.exit_price),realized=Number(trade.realized_pnl);
        if(!Number.isFinite(exit)||exit<=0||!Number.isFinite(realized)||
          !Number.isFinite(Date.parse(trade.closed_at||""))) {
          discrepancies.push({code:"INVALID_CLOSED_TRADE_FIELDS",trade_id:trade.trade_id});
          continue;
        }
        const gross=(exit-entry)*quantity*(trade.side==="BUY"?1:-1);
        const expectedRealized=gross-fees;
        if(!closeEnough(realized,expectedRealized))
          discrepancies.push({code:"REALIZED_PNL_MISMATCH",trade_id:trade.trade_id,
            expected_realized_pnl:expectedRealized,recorded_realized_pnl:realized});
        realizedPnl+=realized;
        const closeEvent=ledgerByEvent.get("TRADE_CLOSED:"+trade.trade_id);
        const openEvent=ledgerByEvent.get("TRADE_OPENED:"+trade.trade_id);
        const closeMetadata=(()=>{try{return JSON.parse(closeEvent?.metadata_json||"{}");}catch{return {};}})();
        const legacyClose=closeMetadata.legacy_backfill===true;
        if(!legacyClose&&(!openEvent||openEvent.event_type!=="TRADE_OPENED"||
          !Number.isFinite(Number(openEvent.amount))||Number(openEvent.amount)>0))
          discrepancies.push({code:"TRADE_OPEN_LEDGER_EVENT_MISSING_OR_INVALID",trade_id:trade.trade_id});
        const expectedCloseAmount=legacyClose?realized:
          realized+(openEvent?-Number(openEvent.amount):0);
        if(!closeEvent||closeEvent.event_type!=="TRADE_CLOSED"||
          !closeEnough(Number(closeEvent.amount),expectedCloseAmount))
          discrepancies.push({code:"TRADE_CLOSE_LEDGER_EVENT_MISSING_OR_INVALID",trade_id:trade.trade_id});
        const count=notificationCounts.get(trade.trade_id+":TRADE_CLOSED")||0;
        if(count!==1) discrepancies.push({code:count===0?"CLOSED_TRADE_NOTIFICATION_MISSING":"DUPLICATE_CLOSED_TRADE_NOTIFICATIONS",
          trade_id:trade.trade_id,count});
      } else {
        discrepancies.push({code:"INVALID_TRADE_STATUS",trade_id:trade.trade_id,status:trade.status});
      }
    }
    for(const row of notifications) {
      if(row.event_type==="TRADE_CLOSED"&&!trades.some(trade=>trade.trade_id===row.trade_id&&trade.status==="CLOSED"))
        discrepancies.push({code:"ORPHAN_CLOSED_TRADE_NOTIFICATION",trade_id:row.trade_id});
    }
    // An unverified partial ledger is deliberately excluded from the legacy balance.
    const tradesById=new Map(trades.map(trade=>[trade.trade_id,trade]));
    for(const row of ledgerRows) {
      if(row.event_type==="TRADE_OPENED"||row.event_type==="TRADE_CLOSED") {
        let metadata={};
        try { metadata=JSON.parse(row.metadata_json||"{}"); } catch {}
        const tradeId=metadata.trade_id||String(row.event_id||"").split(":").slice(1).join(":");
        const trade=tradesById.get(tradeId);
        if(!trade) discrepancies.push({code:"ORPHAN_TRADE_LEDGER_EVENT",ledger_id:row.id,
          event_type:row.event_type,trade_id:tradeId||null});
        else if(row.event_type==="TRADE_CLOSED"&&trade.status!=="CLOSED")
          discrepancies.push({code:"OPEN_TRADE_HAS_CLOSE_LEDGER_EVENT",ledger_id:row.id,trade_id:tradeId});
      } else if(row.event_type!=="ACCOUNT_OPENED") {
        discrepancies.push({code:"UNKNOWN_LEDGER_EVENT_TYPE",ledger_id:row.id,event_type:row.event_type});
      }
    }
    const expectedBalance=ledgerStatus==="PARTIAL_UNKNOWN"?
      calculateLegacyPaperBalance({startingCapital:Number(account.starting_capital),
        realizedPnl,openFees}):ledgerBalance;
    if(ledgerStatus==="PARTIAL_UNKNOWN")
      discrepancies.push({code:"LEDGER_MIGRATION_INCOMPLETE"});
    if(!Number.isFinite(expectedBalance))
      discrepancies.push({code:"NON_FINITE_DERIVED_BALANCE"});
    const ledgerImplemented=ledgerStatus==="READY"||ledgerStatus==="LEGACY_BACKFILLED";
    return {account_id:account.account_id,currency:account.currency,
      integrity_status:discrepancies.length?"NEEDS_REVIEW":ledgerImplemented?"CLEAN":"PARTIAL",
      integrity_note:ledgerImplemented?null:"Ledger contains pre-existing entries without a verifiable migration marker; reconciliation remains partial.",
      discrepancy_count:discrepancies.length,discrepancies,starting_capital:Number(account.starting_capital),
      derived_balance:Number.isFinite(expectedBalance)?Number(expectedBalance.toFixed(8)):null,
      ledger:{events:ledgerRows.length,net_change:Number((ledgerChange-Number(account.starting_capital)).toFixed(8)),
        recorded_running_balance:Number(ledgerBalance.toFixed(8)),
        status:ledgerImplemented?"ACTIVE":"PARTIAL_UNKNOWN",migration_status:ledgerStatus,
        mode:ledgerRows.length?"ACTIVE":"EMPTY"},
      trades:{total:trades.length,open:openTrades,closed:closedTrades,
        realized_pnl:Number(realizedPnl.toFixed(8)),open_fees:Number(openFees.toFixed(8))},
      checked_at:new Date().toISOString(),mode:"PAPER_ONLY",execution_enabled:false};
  }

  createTrade(tokenHash,trade,createdAt) {
    const account=this.authorizedAccount(tokenHash);
    if(!account) return null;
    this._ensureLedgerInitialized(account);
    return this.ctx.storage.transactionSync(()=>this._createTradeAtomic(account,tokenHash,trade,createdAt));
  }

  _createTradeAtomic(account,tokenHash,trade,createdAt) {
    if(!account) return null;
    const existing=trade.idempotency_key ? this.ctx.storage.sql.exec(
      `SELECT trade_id,status,symbol,side,quantity,entry_price,stop_loss,take_profit,
       fees,fee_bps,opened_at,strategy_id,signal_id,signal_type
       FROM paper_trades WHERE idempotency_key=? LIMIT 1`,
      trade.idempotency_key
    ).toArray()[0] : null;
    if(existing) {
      const expectedFee=calculatePaperEntryFee(trade.quantity,trade.entry_price,trade.fee_bps);
      const sameReplay=existing.trade_id===trade.trade_id&&
        existing.symbol===trade.symbol&&existing.side===trade.side&&
        Number(existing.quantity)===Number(trade.quantity)&&
        Number(existing.entry_price)===Number(trade.entry_price)&&
        Number(existing.stop_loss)===Number(trade.stop_loss)&&
        Number(existing.take_profit)===Number(trade.take_profit)&&
        Number(existing.fees)===expectedFee&&Number(existing.fee_bps)===Number(trade.fee_bps)&&existing.opened_at===createdAt&&
        (existing.strategy_id??null)===(trade.strategy_id??null)&&
        (existing.signal_id??null)===(trade.signal_id??null)&&
        (existing.signal_type??null)===(trade.signal_type??null);
      if(!sameReplay) throw new Error("TRADE_IDEMPOTENCY_CONFLICT");
      return {trade_id:existing.trade_id,status:existing.status,duplicate:true,
        symbol:existing.symbol,side:existing.side,quantity:existing.quantity,
        entry_price:existing.entry_price,stop_loss:existing.stop_loss,
        take_profit:existing.take_profit,opened_at:existing.opened_at,
        fees:existing.fees,strategy_id:existing.strategy_id,
        signal_id:existing.signal_id,signal_type:existing.signal_type,
        execution_enabled:false};
    }

    // A signal fingerprint is account-scoped and can create at most one paper
    // trade, even if a client retries with a new request/idempotency key.
    if(typeof trade.signal_id==="string"&&trade.signal_id.trim()) {
      const signalTrade=this.ctx.storage.sql.exec(
        `SELECT trade_id,status,symbol,side,quantity,entry_price,stop_loss,take_profit,
         fees,fee_bps,opened_at,strategy_id,signal_id,signal_type
         FROM paper_trades WHERE signal_id=? LIMIT 1`,
        trade.signal_id
      ).toArray()[0];
      if(signalTrade) {
        const expectedFee=calculatePaperEntryFee(trade.quantity,trade.entry_price,trade.fee_bps);
        const sameSignal=signalTrade.symbol===trade.symbol&&signalTrade.side===trade.side&&
          Number(signalTrade.quantity)===Number(trade.quantity)&&
          Number(signalTrade.entry_price)===Number(trade.entry_price)&&
          Number(signalTrade.stop_loss)===Number(trade.stop_loss)&&
          Number(signalTrade.take_profit)===Number(trade.take_profit)&&
          Number(signalTrade.fees)===expectedFee&&Number(signalTrade.fee_bps)===Number(trade.fee_bps)&&
          (signalTrade.strategy_id??null)===(trade.strategy_id??null)&&
          (signalTrade.signal_type??null)===(trade.signal_type??null);
        if(!sameSignal) throw new Error("SIGNAL_ALREADY_PROCESSED_WITH_DIFFERENT_TRADE");
        return {trade_id:signalTrade.trade_id,status:signalTrade.status,duplicate:true,
          symbol:signalTrade.symbol,side:signalTrade.side,quantity:signalTrade.quantity,
          entry_price:signalTrade.entry_price,stop_loss:signalTrade.stop_loss,
          take_profit:signalTrade.take_profit,opened_at:signalTrade.opened_at,
          fees:signalTrade.fees,strategy_id:signalTrade.strategy_id,
          signal_id:signalTrade.signal_id,signal_type:signalTrade.signal_type,
          execution_enabled:false};
      }
    }

    const openSameSymbol=this.ctx.storage.sql.exec(
      "SELECT trade_id,side FROM paper_trades WHERE status='OPEN' AND symbol=? LIMIT 1",
      trade.symbol
    ).toArray()[0];
    if(openSameSymbol) throw new Error("An open paper trade already exists for this symbol. Close it before opening another.");
    const summary=this.getSummary(tokenHash);
    const open=this.ctx.storage.sql.exec(
      `SELECT COALESCE(SUM(quantity*entry_price),0) AS exposure,
       COALESCE(SUM(quantity*ABS(entry_price-stop_loss)+fees+
         quantity*stop_loss*fee_bps/10000),0) AS risk
       FROM paper_trades WHERE status='OPEN'`
    ).toArray()[0];
    const notional=trade.quantity*trade.entry_price;
    const entryFee=calculatePaperEntryFee(trade.quantity,trade.entry_price,trade.fee_bps);
    const stopFee=calculatePaperEntryFee(trade.quantity,trade.stop_loss,trade.fee_bps);
    const risk=trade.quantity*Math.abs(trade.entry_price-trade.stop_loss)+entryFee+stopFee;
    if(!Number.isFinite(notional)||notional<=0||notional+Number(open.exposure||0)>summary.balance)
      throw new Error("INSUFFICIENT_PAPER_BALANCE");
    if(!Number.isFinite(risk)||risk>summary.balance*0.01+1e-8)
      throw new Error("RISK_LIMIT_EXCEEDED");
    if(Number(open.risk||0)+risk>summary.balance*0.02+1e-8)
      throw new Error("TOTAL_OPEN_RISK_LIMIT_EXCEEDED");

    const day=createdAt.slice(0,10);
    const dayStart=day+"T00:00:00.000Z";
    const dayEnd=new Date(Date.parse(dayStart)+86400000).toISOString();
    const daily=this.ctx.storage.sql.exec(
      `SELECT COALESCE(SUM(CASE WHEN status='CLOSED' THEN realized_pnl ELSE 0 END),0) -
       COALESCE(SUM(CASE WHEN status='OPEN' THEN fees ELSE 0 END),0) AS pnl
       FROM paper_trades
       WHERE (status='CLOSED' AND closed_at>=? AND closed_at<?)
          OR (status='OPEN' AND opened_at>=? AND opened_at<?)`,
      dayStart,dayEnd,dayStart,dayEnd
    ).toArray()[0];
    const dailyLoss=Math.max(0,-Number(daily.pnl||0));
    if(dailyLoss>=Number(account.starting_capital)*0.03-1e-8)
      throw new Error("DAILY_LOSS_LIMIT_EXCEEDED");

    const closed=this.ctx.storage.sql.exec(
      "SELECT realized_pnl FROM paper_trades WHERE status='CLOSED' ORDER BY closed_at ASC,trade_id ASC"
    ).toArray();
    let equity=Number(account.starting_capital),peak=equity;
    for(const row of closed) {
      const pnl=Number(row.realized_pnl);
      if(!Number.isFinite(pnl)) throw new Error("INVALID_STORED_REALIZED_PNL");
      equity+=pnl;
      peak=Math.max(peak,equity);
    }
    const drawdown=peak>0?Math.max(0,(peak-Number(summary.balance))/peak):0;
    if(drawdown>=0.08)
      throw new Error("MAX_DRAWDOWN_LIMIT_EXCEEDED");
    this.ctx.storage.sql.exec(
      `INSERT INTO paper_trades
       (trade_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status,opened_at,fees,fee_bps,idempotency_key,
        strategy_id,signal_id,signal_type)
       VALUES(?,?,?,?,?,?,?,'OPEN',?,?,?,?,?,?,?)`,
      trade.trade_id,trade.symbol,trade.side,trade.quantity,trade.entry_price,
      trade.stop_loss,trade.take_profit,createdAt,entryFee,trade.fee_bps,trade.idempotency_key,
      trade.strategy_id??null,trade.signal_id??null,trade.signal_type??null
    );
    this._appendLedgerEntry(account,"TRADE_OPENED:"+trade.trade_id,"TRADE_OPENED",-entryFee,
      {trade_id:trade.trade_id,symbol:trade.symbol,side:trade.side,entry_fee:entryFee},createdAt);
    return {trade_id:trade.trade_id,symbol:trade.symbol,side:trade.side,quantity:trade.quantity,
      entry_price:trade.entry_price,stop_loss:trade.stop_loss,take_profit:trade.take_profit,
      status:"OPEN",opened_at:createdAt,fees:entryFee,duplicate:false,
      strategy_id:trade.strategy_id??null,signal_id:trade.signal_id??null,
      signal_type:trade.signal_type??null,execution_enabled:false};
  }

  _recordClosedNotification(trade,closed,reason,closedAt) {
    const pnl=Number(closed.realized_pnl||0);
    const notificationId="closed:"+trade.trade_id;
    const title=reason==="STOP_LOSS"?"موقعیت با حد ضرر بسته شد":
      reason==="TAKE_PROFIT"?"موقعیت با حد سود بسته شد":"موقعیت آزمایشی بسته شد";
    const message=trade.symbol+" • "+(trade.side==="BUY"?"خرید":"فروش")+
      " • سود/زیان: "+pnl.toFixed(2);
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO paper_notifications
       (notification_id,event_type,trade_id,title,message,realized_pnl,created_at,metadata_json)
       VALUES(?,?,?,?,?,?,?,?)`,
      notificationId,"TRADE_CLOSED",trade.trade_id,title,message,pnl,closedAt,
      JSON.stringify({symbol:trade.symbol,side:trade.side,quantity:trade.quantity,
        entry_price:trade.entry_price,exit_price:closed.exit_price,reason,fees:closed.fees})
    );
  }

  listNotifications(tokenHash,limit=30) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const safeLimit=Math.max(1,Math.min(Number.isInteger(limit)?limit:30,100));
    return this.ctx.storage.sql.exec(
      `SELECT notification_id,event_type,trade_id,title,message,realized_pnl,created_at,metadata_json
       FROM paper_notifications ORDER BY created_at DESC LIMIT ?`,safeLimit
    ).toArray().map(row=>({...row,metadata:JSON.parse(row.metadata_json||"{}")}));
  }

  getDailyReport(tokenHash,day) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const start=day+"T00:00:00.000Z";
    const end=new Date(Date.parse(start)+86400000).toISOString();
    const row=this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS closed_trades,
       SUM(CASE WHEN realized_pnl>0 THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN realized_pnl<0 THEN 1 ELSE 0 END) AS losses,
       COALESCE(SUM(realized_pnl),0) AS realized_pnl,
       COALESCE(SUM(fees),0) AS fees
       FROM paper_trades WHERE status='CLOSED' AND closed_at>=? AND closed_at<?`,start,end
    ).toArray()[0]||{};
    return {date:day,timezone:"UTC",closed_trades:Number(row.closed_trades||0),
      wins:Number(row.wins||0),losses:Number(row.losses||0),
      realized_pnl:Number(row.realized_pnl||0),fees:Number(row.fees||0),
      mode:"PAPER_ONLY",execution_enabled:false};
  }

  getPerformanceReport(tokenHash,period="week",asOf) {
    const account=this.authorizedAccount(tokenHash);
    if(!account) return null;
    const days=period==="month"?30:7;
    const endDate=asOf||new Date().toISOString().slice(0,10);
    const endMs=Date.parse(endDate+"T00:00:00.000Z");
    if(!Number.isFinite(endMs)||new Date(endMs).toISOString().slice(0,10)!==endDate)
      throw new Error("INVALID_REPORT_DATE");
    const startDate=new Date(endMs-(days-1)*86400000).toISOString().slice(0,10);
    const daily=this.ctx.storage.sql.exec(
      `SELECT substr(closed_at,1,10) AS day,COUNT(*) AS trades,
       SUM(CASE WHEN realized_pnl>0 THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN realized_pnl<0 THEN 1 ELSE 0 END) AS losses,
       COALESCE(SUM(realized_pnl),0) AS pnl,
       COALESCE(SUM(fees),0) AS fees,
       COALESCE(SUM(CASE WHEN realized_pnl>0 THEN realized_pnl ELSE 0 END),0) AS winning_pnl,
       COALESCE(SUM(CASE WHEN realized_pnl<0 THEN -realized_pnl ELSE 0 END),0) AS losing_pnl
       FROM paper_trades WHERE status='CLOSED' AND closed_at>=? AND closed_at<?
       GROUP BY substr(closed_at,1,10) ORDER BY day ASC`,
      startDate+"T00:00:00.000Z",new Date(endMs+86400000).toISOString()
    ).toArray();
    const byDay=new Map(daily.map(row=>[row.day,row]));
    let balance=Number(account.starting_capital),peak=balance,maxDrawdown=0,maxDrawdownPct=0;
    let trades=0,wins=0,losses=0,netPnl=0,fees=0,grossProfit=0,grossLoss=0;
    const equityCurve=[];
    for(let i=0;i<days;i++){
      const day=new Date(Date.parse(startDate+"T00:00:00.000Z")+i*86400000).toISOString().slice(0,10);
      const row=byDay.get(day);
      const pnl=Number(row?.pnl||0);
      balance+=pnl;trades+=Number(row?.trades||0);wins+=Number(row?.wins||0);
      losses+=Number(row?.losses||0);netPnl+=pnl;fees+=Number(row?.fees||0);
      grossProfit+=Number(row?.winning_pnl||0);grossLoss+=Number(row?.losing_pnl||0);
      peak=Math.max(peak,balance);
      const drawdown=Math.max(0,peak-balance);
      maxDrawdown=Math.max(maxDrawdown,drawdown);
      maxDrawdownPct=Math.max(maxDrawdownPct,peak>0?drawdown/peak*100:0);
      equityCurve.push({date:day,balance:Number(balance.toFixed(8)),daily_pnl:Number(pnl.toFixed(8))});
    }
    const avgWin=wins?grossProfit/wins:0,avgLoss=losses?grossLoss/losses:0;
    return {period,timezone:"UTC",start_date:startDate,end_date:endDate,starting_balance:Number(account.starting_capital),
      ending_balance:Number(balance.toFixed(8)),closed_trades:trades,wins,losses,
      win_rate_pct:trades?Number((wins/trades*100).toFixed(2)):0,
      net_pnl:Number(netPnl.toFixed(8)),fees:Number(fees.toFixed(8)),
      winning_pnl:Number(grossProfit.toFixed(8)),losing_pnl:Number(grossLoss.toFixed(8)),
      profit_factor:grossLoss>0?Number((grossProfit/grossLoss).toFixed(4)):null,
      average_win:Number(avgWin.toFixed(8)),average_loss:Number(avgLoss.toFixed(8)),
      expectancy:trades?Number((netPnl/trades).toFixed(8)):0,
      max_drawdown:Number(maxDrawdown.toFixed(8)),max_drawdown_pct:Number(maxDrawdownPct.toFixed(2)),
      equity_curve:equityCurve,mode:"PAPER_ONLY",execution_enabled:false};
  }

  getStrategyAttribution(tokenHash) {
    if(!this.authorizedAccount(tokenHash)) return null;
    const rows=this.ctx.storage.sql.exec(
      `SELECT COALESCE(strategy_id,'UNATTRIBUTED') AS strategy_id,
       COALESCE(signal_type,'UNATTRIBUTED') AS signal_type,
       COUNT(*) AS closed_trades,
       SUM(CASE WHEN realized_pnl>0 THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN realized_pnl<0 THEN 1 ELSE 0 END) AS losses,
       COALESCE(SUM(realized_pnl),0) AS net_pnl,
       COALESCE(SUM(CASE WHEN realized_pnl>0 THEN realized_pnl ELSE 0 END),0) AS gross_profit,
       COALESCE(SUM(CASE WHEN realized_pnl<0 THEN -realized_pnl ELSE 0 END),0) AS gross_loss,
       COALESCE(SUM(fees),0) AS fees
       FROM paper_trades WHERE status='CLOSED'
       GROUP BY COALESCE(strategy_id,'UNATTRIBUTED'),COALESCE(signal_type,'UNATTRIBUTED')
       ORDER BY closed_trades DESC`
    ).toArray();
    const groups=rows.map(row=>{
      const count=Number(row.closed_trades||0),wins=Number(row.wins||0);
      const grossProfit=Number(row.gross_profit||0),grossLoss=Number(row.gross_loss||0);
      const net=Number(row.net_pnl||0);
      const enough=count>=20;
      const weak=enough&&(net<0||(wins/count)<0.35);
      return {strategy_id:row.strategy_id,signal_type:row.signal_type,
        closed_trades:count,wins,losses:Number(row.losses||0),
        win_rate_pct:count?Number((wins/count*100).toFixed(2)):0,
        net_pnl:Number(net.toFixed(8)),fees:Number(Number(row.fees||0).toFixed(8)),
        profit_factor:grossLoss>0?Number((grossProfit/grossLoss).toFixed(4)):null,
        expectancy:count?Number((net/count).toFixed(8)):0,
        sample_quality:enough?"MINIMUM_SAMPLE_MET":"INSUFFICIENT_SAMPLE",
        risk_guidance:weak?"CONSIDER_HALF_RISK":"NO_AUTOMATIC_CHANGE"};
    });
    const total=groups.reduce((sum,g)=>sum+g.closed_trades,0);
    const attributed=groups.filter(g=>g.strategy_id!=="UNATTRIBUTED").reduce((sum,g)=>sum+g.closed_trades,0);
    return {groups,total_closed_trades:total,attributed_closed_trades:attributed,
      unattributed_closed_trades:total-attributed,minimum_sample_for_guidance:20,
      guidance_policy:"Advisory only: after at least 20 closed trades, negative net PnL or win rate below 35% suggests considering half risk. Never increases risk and never changes execution settings.",
      mode:"PAPER_ONLY",execution_enabled:false};
  }

  closeTrade(tokenHash,tradeId,exitPrice,feeBps,closedAt) {
    const account=this.authorizedAccount(tokenHash);
    if(!account) return null;
    this._ensureLedgerInitialized(account);
    return this.ctx.storage.transactionSync(()=>this._closeTradeAtomic(account,tradeId,exitPrice,feeBps,closedAt));
  }

  _closeTradeAtomic(account,tradeId,exitPrice,feeBps,closedAt) {
    const trade=this.ctx.storage.sql.exec("SELECT * FROM paper_trades WHERE trade_id=? AND status='OPEN' LIMIT 1",tradeId).toArray()[0];
    if(!trade) return {error:"TRADE_NOT_OPEN"};
    const entryFee=Number(trade.fees||0);
    const exitFee=calculatePaperEntryFee(trade.quantity,exitPrice,feeBps);
    const settlement=calculatePaperSettlement({side:trade.side,quantity:trade.quantity,
      entryPrice:trade.entry_price,exitPrice,entryFee,exitFee});
    const {gross,totalFees:fees,realizedPnl:realized,ledgerCloseAmount}=settlement;
    const updated=this.ctx.storage.sql.exec(
      `UPDATE paper_trades SET status='CLOSED',closed_at=?,exit_price=?,realized_pnl=?,fees=?
       WHERE trade_id=? AND status='OPEN'
       RETURNING trade_id,status,exit_price,realized_pnl,fees,closed_at`,
      closedAt,exitPrice,realized,fees,tradeId
    ).toArray()[0];
    if(updated) {
      this._appendLedgerEntry(account,"TRADE_CLOSED:"+tradeId,"TRADE_CLOSED",ledgerCloseAmount,
        {trade_id:tradeId,symbol:trade.symbol,side:trade.side,gross_pnl:gross,
          exit_fee:exitFee,entry_fee:entryFee,realized_pnl:realized},closedAt);
      this._recordClosedNotification(trade,updated,"MANUAL",closedAt);
    }
    return updated??{error:"TRADE_NOT_OPEN"};
  }
  monitorTrades(tokenHash,symbol,candle,feeBps,checkedAt) {
    if(!this.authorizedAccount(tokenHash)) return null;
    return this._monitorTrades(symbol,candle,feeBps,checkedAt);
  }

  monitorTradesInternal(symbol,candle,feeBps,checkedAt) {
    return this._monitorTrades(symbol,candle,feeBps,checkedAt);
  }

  _monitorTrades(symbol,candleInput,feeBps,checkedAt) {
    const account=this.ctx.storage.sql.exec(
      "SELECT account_id,starting_capital,created_at FROM accounts LIMIT 1"
    ).toArray()[0];
    if(!account) throw new Error("PAPER_ACCOUNT_NOT_FOUND");
    this._ensureLedgerInitialized(account);
    return this.ctx.storage.transactionSync(()=>this._monitorTradesAtomic(account,symbol,candleInput,feeBps,checkedAt));
  }

  _monitorTradesAtomic(account,symbol,candleInput,feeBps,checkedAt) {
    if(typeof symbol!=="string"||!/^[A-Z0-9_-]{1,20}$/.test(symbol))
      throw new Error("INVALID_MONITOR_SYMBOL");
    if(typeof feeBps!=="number"||!Number.isFinite(feeBps)||feeBps<0||feeBps>1000)
      throw new Error("INVALID_MONITOR_FEE");
    if(typeof checkedAt!=="string"||!Number.isFinite(Date.parse(checkedAt)))
      throw new Error("INVALID_MONITOR_CHECK_TIME");
    const candles=(Array.isArray(candleInput)?candleInput:[candleInput])
      .filter(Boolean).slice().sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    if(!candles.length) throw new Error("NO_COMPLETED_CANDLES");
    let previousCandleAt=-Infinity;
    for(const candle of candles) {
      const candleAt=Date.parse(candle?.timestamp);
      const values=[candle?.open,candle?.high,candle?.low,candle?.close];
      if(!Number.isFinite(candleAt)||!values.every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0)||
        candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)||
        candle.high<candle.low)
        throw new Error("INVALID_MONITOR_CANDLE");
      if(candleAt<=previousCandleAt) throw new Error("DUPLICATE_OR_UNORDERED_MONITOR_CANDLE");
      previousCandleAt=candleAt;
    }
    const rows=this.ctx.storage.sql.exec(
      "SELECT * FROM paper_trades WHERE status='OPEN' AND symbol=? ORDER BY opened_at ASC",symbol
    ).toArray();
    const results=[];
    for(const trade of rows) {
      let processedAny=false, closedRow=null, lastChecked=trade.last_checked_at||null;
      const openedAt=Date.parse(trade.opened_at);
      for(const candle of candles) {
        const candleAt=Date.parse(candle.timestamp);
        if(!Number.isFinite(candleAt)||!Number.isFinite(openedAt)) throw new Error("INVALID_TRADE_OR_CANDLE_TIMESTAMP");
        // Never use an OHLC candle that began before this position was opened.
        if(candleAt<=openedAt) continue;
        if(lastChecked&&lastChecked>=candle.timestamp) continue;
        processedAny=true;
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
          exitPrice=trade.take_profit;
        }
        if(exitPrice!==null) {
          const entryFee=Number(trade.fees||0);
          const exitFee=calculatePaperEntryFee(trade.quantity,exitPrice,feeBps);
          const settlement=calculatePaperSettlement({side:trade.side,quantity:trade.quantity,
            entryPrice:trade.entry_price,exitPrice,entryFee,exitFee});
          const {gross,totalFees:fees,realizedPnl:realized,ledgerCloseAmount}=settlement;
          closedRow=this.ctx.storage.sql.exec(
            `UPDATE paper_trades SET status='CLOSED',closed_at=?,exit_price=?,realized_pnl=?,fees=?,last_checked_at=?
             WHERE trade_id=? AND status='OPEN'
             RETURNING trade_id,status,exit_price,realized_pnl,fees,closed_at`,
            checkedAt,exitPrice,realized,fees,candle.timestamp,trade.trade_id
          ).toArray()[0];
          if(closedRow) {
            closedRow.exit_reason=reason;
            this._appendLedgerEntry(account,"TRADE_CLOSED:"+trade.trade_id,"TRADE_CLOSED",ledgerCloseAmount,
              {trade_id:trade.trade_id,symbol:trade.symbol,side:trade.side,gross_pnl:gross,
                exit_fee:exitFee,entry_fee:Number(trade.fees||0),realized_pnl:realized,reason},checkedAt);
            this._recordClosedNotification(trade,closedRow,reason,checkedAt);
          }
          break;
        }
        this.ctx.storage.sql.exec(
          "UPDATE paper_trades SET last_checked_at=? WHERE trade_id=? AND status='OPEN'",
          candle.timestamp,trade.trade_id
        );
        lastChecked=candle.timestamp;
      }
      if(closedRow) results.push(closedRow);
      else if(processedAny) results.push({trade_id:trade.trade_id,status:"OPEN",checked_candle_at:lastChecked});
      else results.push({trade_id:trade.trade_id,status:"UNCHANGED",
        reason:lastChecked?"CANDLE_ALREADY_PROCESSED":"NO_CANDLE_AFTER_TRADE_OPEN"});
    }
    const lastCandle=candles[candles.length-1];
    return {checked_candle_at:lastCandle.timestamp,checked_at:checkedAt,processed:results.length,
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
