import importlib.util
import sqlite3
import sys
import types
from pathlib import Path


class FakeCursor:
    def __init__(self, cursor):
        self.cursor = cursor

    def toArray(self):
        if self.cursor.description is None:
            return []
        columns = [column[0] for column in self.cursor.description]
        return [dict(zip(columns, row)) for row in self.cursor.fetchall()]


class FakeSql:
    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row

    def exec(self, query, *args):
        if not args and ";" in query.strip().rstrip(";"):
            self.connection.executescript(query)
            return FakeCursor(self.connection.execute("SELECT 1 WHERE 0"))
        return FakeCursor(self.connection.execute(query, args))


class FakeStorage:
    def __init__(self):
        self.sql = FakeSql()


class FakeContext:
    def __init__(self):
        self.storage = FakeStorage()


class FakeDurableObject:
    def __init__(self, ctx, env):
        self.ctx = ctx
        self.env = env


class FakeWorkerEntrypoint:
    pass


class FakeResponse:
    pass


def load_worker_with_runtime_stub(monkeypatch):
    fake_workers = types.ModuleType("workers")
    fake_workers.DurableObject = FakeDurableObject
    fake_workers.WorkerEntrypoint = FakeWorkerEntrypoint
    fake_workers.Response = FakeResponse
    fake_workers.asgi = types.SimpleNamespace(fetch=None)
    monkeypatch.setitem(sys.modules, "workers", fake_workers)

    worker_path = Path(__file__).parents[1] / "worker.py"
    spec = importlib.util.spec_from_file_location("paper_account_worker_test", worker_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_durable_object_persists_account_and_requires_matching_token(monkeypatch):
    worker = load_worker_with_runtime_stub(monkeypatch)
    ctx = FakeContext()
    account = worker.PaperAccount(ctx, None)

    created = account.create_account(
        "a" * 32, "b" * 64, "USD", 12500.0, "2026-11-24T00:00:00+00:00"
    )
    assert created["balance"] == 12500.0
    assert created["trading_enabled"] is False

    summary = account.get_summary("b" * 64)
    assert summary["account_id"] == "a" * 32
    assert summary["balance"] == 12500.0
    assert summary["total_trades"] == 0
    assert summary["ledger_events"] == 0
    assert summary["execution_enabled"] is False
    assert account.get_summary("c" * 64) is None
    assert account.list_trades("c" * 64) is None
    assert account.list_trades("b" * 64) == []


def test_durable_object_enforces_per_ip_daily_account_creation_limit(monkeypatch):
    worker = load_worker_with_runtime_stub(monkeypatch)
    account = worker.PaperAccount(FakeContext(), None)
    assert account.allow_creation("hashed-ip-one", "2026-11-24") is True
    assert account.allow_creation("hashed-ip-one", "2026-11-24") is True
    assert account.allow_creation("hashed-ip-one", "2026-11-24") is True
    assert account.allow_creation("hashed-ip-one", "2026-11-24") is False
    assert account.allow_creation("hashed-ip-one", "2026-11-25") is True
    assert account.allow_creation("hashed-ip-two", "2026-11-24") is True
