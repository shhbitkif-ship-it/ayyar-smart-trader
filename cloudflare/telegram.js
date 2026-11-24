export async function handleTelegramWebhook(request, env, snapshot, json) {
  if (!env?.BOT_TOKEN || !env?.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Telegram webhook secrets are not configured" }, 503);
  }
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  let update;
  try { update = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = String(message?.text || "").trim().split("@")[0].toLowerCase();
  if (!chatId || !text) return json({ ok: true, ignored: true });

  let reply;
  if (text === "/start" || text === "/help") {
    reply = "سلام! به عیار هوشمند خوش آمدید.\n/gold اونس جهانی\n/iran قیمت‌های ایران\n/market همه نرخ‌ها\nقیمت‌ها شاخصی هستند و توصیه معاملاتی یا قیمت اجرایی بروکر نیستند.";
  } else if (["/gold", "/iran", "/market"].includes(text)) {
    const data = await snapshot();
    const rows = Array.isArray(data?.quotes) ? data.quotes : [];
    const selected = text === "/gold" ? rows.filter(q => q.symbol === "XAUUSD")
      : text === "/iran" ? rows.filter(q => ["GOLD18","GOLD24","MESGHAL","COIN_EMAMI","COIN_HALF","COIN_QUARTER","USD_IRT"].includes(q.symbol))
      : rows;
    const labels = {GOLD18:"طلای ۱۸ عیار",GOLD24:"طلای ۲۴ عیار",MESGHAL:"مظنه",COIN_EMAMI:"سکه امامی",COIN_HALF:"نیم‌سکه",COIN_QUARTER:"ربع‌سکه",USD_IRT:"دلار آزاد",XAUUSD:"اونس جهانی"};
    const lines = selected.map(q => {
      const price = q.status === "LIVE" && q.price != null
        ? (q.symbol === "XAUUSD" ? Number(q.price).toLocaleString("en-US",{maximumFractionDigits:2}) + " USD/oz" : Number(q.price).toLocaleString("en-US",{maximumFractionDigits:0}) + " تومان")
        : "قیمت معتبر/تازه موجود نیست";
      return (labels[q.symbol] || q.name) + ": " + price + " [" + q.status + "]";
    });
    reply = (lines.length ? lines.join("\n") : "داده بازار در دسترس نیست.")
      + "\nمنبع: NerkhAra | به‌روزرسانی تقریبی هر ۱۰ دقیقه"
      + "\nاین داده شاخصی است؛ سیگنال خرید/فروش صادر نمی‌شود.";
  } else {
    return json({ ok: true, ignored: true });
  }

  const sent = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({chat_id:chatId,text:reply,disable_web_page_preview:true})
  });
  if (!sent.ok) return json({ error: "Telegram delivery failed" }, 502);
  return json({ ok: true });
}
