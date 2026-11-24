import json
from pathlib import Path


def test_cloudflare_worker_declares_sqlite_paper_account_storage():
    config_path = Path(__file__).parents[1] / "wrangler.jsonc"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    assert config["main"] == "worker.py"
    assert config["compatibility_flags"] == ["python_workers"]
    assert config["durable_objects"]["bindings"] == [
        {"name": "PAPER_ACCOUNTS", "class_name": "PaperAccount"}
    ]
    assert config["migrations"] == [
        {"tag": "v1-paper-accounts", "new_sqlite_classes": ["PaperAccount"]}
    ]


def test_cloudflare_worker_entrypoint_has_paper_account_routes_and_asgi_fallback():
    worker_path = Path(__file__).parents[1] / "worker.py"
    source = worker_path.read_text(encoding="utf-8")
    compile(source, str(worker_path), "exec")
    assert "class PaperAccount(DurableObject)" in source
    assert "class Default(WorkerEntrypoint)" in source
    assert "getByName(account_id)" in source
    assert "await asgi.fetch(app, request, self.env)" in source
    assert "hash_access_token(auth[7:])" in source
