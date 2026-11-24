import os
import logging
import requests
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

TOKEN = os.getenv("BOT_TOKEN")
API_BASE_URL = os.getenv("API_BASE_URL", "https://ayyar-smart-trader-api.ayyar-smart-trader.workers.dev").rstrip("/")
logging.basicConfig(level=logging.INFO)

SYMBOLS_IRAN = {"GOLD18": "طلای ۱۸ عیار", "GOLD24": "طلای ۲۴ عیار", "MESGHAL": "مظنه آبشده",
                "COIN_EMAMI": "سکه امامی", "COIN_HALF": "نیم‌سکه", "COIN_QUARTER": "ربع‌سکه", "USD_IRT": "دلار تهران"}

def market_quotes():
    response = requests.get(f"{API_BASE_URL}/v1/market/quotes", timeout=10)
    response.raise_for_status()
    payload = response.json()
    return payload.get("quotes", []) if isinstance(payload, dict) else []

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "سلام! به ربات عیار هوشمند خوش آمدید.\n\n"
        "/gold — اونس جهانی طلا\n/iran — قیمت‌های بازار ایران\n/market — خلاصه همه نرخ‌ها\n"
        "قیمت‌ها همراه منبع و وضعیت تازگی نمایش داده می‌شوند. داده نامعتبر یا قدیمی مبنای سیگنال نیست."
    )

async def gold(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = market_quotes()
        q = next((x for x in rows if x.get("symbol") == "XAUUSD"), None)
        if not q or q.get("status") != "LIVE" or q.get("price") is None:
            await update.message.reply_text("قیمت معتبر و تازه اونس در دسترس نیست؛ فعلاً سیگنالی صادر نمی‌شود.")
            return
        await update.message.reply_text(
            f"اونس جهانی طلا: {q['price']:,.2f} دلار\nمنبع: {q.get('source','—')}\n"
            f"زمان منبع: {q.get('timestamp','—')}\nوضعیت: {q.get('status','—')}"
        )
    except Exception:
        logging.exception("Market quote request failed")
        await update.message.reply_text("اتصال به سرویس قیمت در حال حاضر برقرار نیست.")

async def iran(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = market_quotes()
        lines = ["قیمت‌های بازار ایران"]
        for q in rows:
            if q.get("symbol") in SYMBOLS_IRAN:
                value = f"{q['price']:,.0f} تومان" if q.get("price") is not None else "ناموجود"
                lines.append(f"{SYMBOLS_IRAN[q['symbol']]}: {value} | {q.get('status','—')}")
        lines.append("منبع و زمان هر نرخ در سرویس اپ ثبت می‌شود.")
        await update.message.reply_text("\n".join(lines))
    except Exception:
        logging.exception("Iran quote request failed")
        await update.message.reply_text("دریافت نرخ‌های ایران در حال حاضر ممکن نیست.")

async def market(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await gold(update, context)
    await iran(update, context)

def main():
    if not TOKEN:
        raise RuntimeError("BOT_TOKEN تنظیم نشده است")
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("gold", gold))
    app.add_handler(CommandHandler("iran", iran))
    app.add_handler(CommandHandler("market", market))
    app.run_polling()

if __name__ == "__main__":
    main()
