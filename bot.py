
import os
import logging
import requests
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

TOKEN = os.getenv("BOT_TOKEN")

logging.basicConfig(level=logging.INFO)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "سلام! 👋\n"
        "به ربات عیار هوشمند خوش آمدی.\n\n"
        "برای دریافت قیمت طلا دستور /gold را بفرست."
    )

async def gold(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        response = requests.get(
            "https://api.gold-api.com/price/XAU",
            timeout=10
        )
        response.raise_for_status()
        data = response.json()
        price = data.get("price")

        await update.message.reply_text(
            f"قیمت لحظه‌ای هر اونس طلا: {price} دلار"
        )
    except Exception:
        await update.message.reply_text(
            "دریافت قیمت طلا در حال حاضر امکان‌پذیر نیست."
        )

def main():
    if not TOKEN:
        raise RuntimeError("BOT_TOKEN تنظیم نشده است")

    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("gold", gold))
    app.run_polling()

if __name__ == "__main__":
    main()
      
