"""Cloudflare Workers ASGI entrypoint for the existing FastAPI backend."""
from workers import asgi
from app.main import app

# Cloudflare's Python Workers runtime provides the ASGI adapter.
Default = asgi.entrypoint(app)
