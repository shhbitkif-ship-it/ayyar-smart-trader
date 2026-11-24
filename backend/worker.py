"""Cloudflare Python Worker entrypoint and SQLite-backed paper accounts."""
import hashlib
import json
from datetime import datetime, timezone
from urllib.parse import urlparse

from workers import DurableObject, WorkerEntrypoint, Response, asgi

from app.main import app
from app.paper_accounts import (
    generate_account_credentials,
    hash_access_token,
    validate_account_settings,
)


def _json(payload, status=200):
    return Response(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        status=status,
        headers={
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
    )


class PaperAccount(DurableObject):
    """One strongly-consistent SQLite-backed account per paper portfolio."""

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        self.sql.exec("""
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
        """)

    def allow_creation(self, ip_hash, day):
        rows = self.sql.exec(
            """INSERT INTO creation_limits(ip_hash, day, count)
               VALUES (?, ?, 1)
               ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
               WHERE count < 3
               RETURNING count""",
            ip_hash, day,
        ).toArray()
        return len(rows) == 1

    def create_account(self, account_id, token_hash, currency, starting_capital, created_at):
        self.sql.exec(
            """INSERT INTO accounts(account_id, token_hash, currency, starting_capital, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            account_id, token_hash, currency, starting_capital, created_at,
        )
        return {
            "account_id": account_id,
            "currency": currency,
            "starting_capital": starting_capital,
            "balance": starting_capital,
            "created_at": created_at,
            "trading_enabled": False,
        }

    def _authorized_account(self, token_hash):
        rows = self.sql.exec(
            """SELECT account_id, currency, starting_capital, created_at
               FROM accounts WHERE token_hash = ? LIMIT 1""",
            token_hash,
        ).toArray()
        return rows[0] if rows else None

    def get_summary(self, token_hash):
        account = self._authorized_account(token_hash)
        if account is None:
            return None
        ledger = self.sql.exec(
            """SELECT COALESCE(SUM(amount), 0) AS net_ledger_change,
                      COUNT(*) AS ledger_events
               FROM ledger_entries"""
        ).toArray()[0]
        trade_stats = self.sql.exec(
            """SELECT COUNT(*) AS total_trades,
                      SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open_trades,
                      SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) AS closed_trades,
                      COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN realized_pnl ELSE 0 END), 0) AS realized_pnl
               FROM paper_trades"""
        ).toArray()[0]
        balance = account["starting_capital"] + float(ledger["net_ledger_change"] or 0) + float(trade_stats["realized_pnl"] or 0)
        return {
            "account_id": account["account_id"],
            "currency": account["currency"],
            "starting_capital": account["starting_capital"],
            "balance": balance,
            "realized_pnl": float(trade_stats["realized_pnl"] or 0),
            "total_trades": trade_stats["total_trades"] or 0,
            "open_trades": trade_stats["open_trades"] or 0,
            "closed_trades": trade_stats["closed_trades"] or 0,
            "ledger_events": ledger["ledger_events"] or 0,
            "created_at": account["created_at"],
            "trading_enabled": False,
            "execution_enabled": False,
        }

    def list_trades(self, token_hash, limit=50):
        if self._authorized_account(token_hash) is None:
            return None
        limit = max(1, min(int(limit), 100))
        return self.sql.exec(
            """SELECT trade_id, symbol, side, quantity, entry_price, stop_loss,
                      take_profit, status, opened_at, closed_at, exit_price,
                      realized_pnl, fees
               FROM paper_trades ORDER BY opened_at DESC LIMIT ?""",
            limit,
        ).toArray()


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        parsed = urlparse(request.url)
        path = parsed.path.rstrip("/") or "/"

        if path == "/v1/paper/accounts" and request.method == "POST":
            try:
                payload = json.loads(await request.text() or "{}")
                capital, currency = validate_account_settings(payload)
                client_ip = request.headers.get("cf-connecting-ip")
                if not client_ip:
                    return _json({"error": "Client address unavailable; account creation is blocked"}, 400)

                bootstrap = self.env.PAPER_ACCOUNTS.getByName("__paper_bootstrap_guard__")
                ip_hash = hashlib.sha256(client_ip.encode("utf-8")).hexdigest()
                day = datetime.now(timezone.utc).date().isoformat()
                if not bootstrap.allow_creation(ip_hash, day):
                    return _json({"error": "Daily paper-account creation limit reached for this network"}, 429)

                account_id, access_token, token_hash = generate_account_credentials()
                account = self.env.PAPER_ACCOUNTS.getByName(account_id)
                created_at = datetime.now(timezone.utc).isoformat()
                result = await account.create_account(
                    account_id, token_hash, currency, capital, created_at
                )
                return _json({
                    **result,
                    "access_token": access_token,
                    "token_type": "Bearer",
                    "token_notice": "This token is shown once. Store it securely; it cannot be recovered.",
                    "execution_enabled": False,
                }, 201)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return _json({"error": str(exc)}, 400)
            except Exception:
                return _json({"error": "Paper account could not be created"}, 503)

        if path.startswith("/v1/paper/accounts/"):
            parts = path.split("/")
            if len(parts) not in (5, 6) or (len(parts) == 6 and parts[5] != "trades"):
                return _json({"error": "Not found"}, 404)
            account_id = parts[4]
            if not account_id or len(account_id) != 32 or any(c not in "0123456789abcdef" for c in account_id):
                return _json({"error": "Not found"}, 404)
            auth = request.headers.get("authorization", "")
            if not auth.startswith("Bearer "):
                return _json({"error": "Bearer authorization required"}, 401)
            try:
                token_hash = hash_access_token(auth[7:])
            except ValueError:
                return _json({"error": "Invalid bearer token"}, 401)
            account = self.env.PAPER_ACCOUNTS.getByName(account_id)
            if request.method == "GET" and len(parts) == 5:
                summary = await account.get_summary(token_hash)
                if summary is None:
                    return _json({"error": "Account not found or access denied"}, 404)
                return _json(summary)
            if request.method == "GET" and len(parts) == 6:
                trades = await account.list_trades(token_hash, 50)
                if trades is None:
                    return _json({"error": "Account not found or access denied"}, 404)
                return _json({"trades": trades, "execution_enabled": False})
            return _json({"error": "Method not allowed"}, 405)

        return await asgi.fetch(app, request, self.env)
