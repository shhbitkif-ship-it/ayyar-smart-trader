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
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN last_checked_at TEXT"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN strategy_id TEXT"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN signal_id TEXT"); } catch {}
    try { this.ctx.storage.sql.exec("ALTER TABLE paper_trades ADD COLUMN signal_type TEXT"); } catch {}
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
       (trade_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status,opened_at,fees,idempotency_key,
        strategy_id,signal_id,signal_type)
       VALUES(?,?,?,?,?,?,?,'OPEN',?,?,?,?,?,?)`,
      trade.trade_id,trade.symbol,trade.side,trade.quantity,trade.entry_price,
      trade.stop_loss,trade.take_profit,createdAt,entryFee,trade.idempotency_key,
      trade.strategy_id??null,trade.signal_id??null,trade.signal_type??null
    );
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
    if(updated) this._recordClosedNotification(trade,updated,"MANUAL",closedAt);
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
    const candles=(Array.isArray(candleInput)?candleInput:[candleInput])
      .filter(Boolean).slice().sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    if(!candles.length) throw new Error("NO_COMPLETED_CANDLES");
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
          const direction=isBuy?1:-1;
          const gross=(exitPrice-trade.entry_price)*trade.quantity*direction;
          const exitFee=exitPrice*trade.quantity*feeBps/10000;
          const fees=Number(trade.fees||0)+exitFee;
          const realized=gross-fees;
          if(![gross,exitFee,fees,realized].every(Number.isFinite))
            throw new Error("TRADE_VALUE_OUT_OF_RANGE");
          closedRow=this.ctx.storage.sql.exec(
            `UPDATE paper_trades SET status='CLOSED',closed_at=?,exit_price=?,realized_pnl=?,fees=?,last_checked_at=?
             WHERE trade_id=? AND status='OPEN'
             RETURNING trade_id,status,exit_price,realized_pnl,fees,closed_at`,
            checkedAt,exitPrice,realized,fees,candle.timestamp,trade.trade_id
          ).toArray()[0];
          if(closedRow) {
            closedRow.exit_reason=reason;
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
