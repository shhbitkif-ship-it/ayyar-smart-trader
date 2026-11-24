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
    reply = "سلام! به عیار هوشمند خوش آمدید.\n/gold اونس جهانی\n/iran قیمت‌های ایران\n/market همه نرخ‌ها\n/signals آخرین سیگنال‌ها\n/history تاریخچه سیگنال‌ها\nقیمت‌ها شاخصی هستند و توصیه معاملاتی یا قیمت اجرایی بروکر نیستند.";
  } else if (text === "/signals" || text === "/history") {
    if (!env?.SIGNAL_HISTORY) {
      reply = "آرشیو سیگنال هنوز پیکربندی نشده است.";
    } else {
      try {
        const listed = await env.SIGNAL_HISTORY.list({prefix:"xau:latest:",limit:text==="/signals"?1:5});
        const records = await Promise.all((listed.keys || []).map(item => env.SIGNAL_HISTORY.get(item.name,"json")));
        const valid = records.filter(Boolean).sort((a,b)=>Date.parse(b.recorded_at)-Date.parse(a.recorded_at));
        const lines = valid.map(item => {
          const direction = item.signal==="BUY" ? "خرید" : item.signal==="SELL" ? "فروش" : "عدم معامله";
          return direction + " | امتیاز " + item.confidence + "/100"
            + "\nروند: " + item.trend + " | ثبت: " + item.recorded_at
            + (item.entry!=null ? "\nورود: "+item.entry+" | حدضرر: "+item.stop_loss+" | هدف: "+item.take_profit : "");
        });
        reply = lines.length ? lines.join("\n\n")
          + "\n\nداده پژوهشی XAUS؛ امتیاز احتمال موفقیت نیست و سفارش خودکار انجام نمی‌شود."
          : "هنوز سابقه‌ای از سیگنال‌های چندتایم‌فریمی ثبت نشده است.";
      } catch {
        reply = "دریافت تاریخچه سیگنال‌ها موقتاً ناموفق بود.";
      }
    }
  } else if (["/gold", "/iran", "/market"].includes(text)) {
    const data = await snapshot(env);
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
    const provider = rows[0]?.source || "منبع بازار";
    const attribution = provider === "Talasanj" ? "قیمت‌ها از طلاسنج: https://talasanj.info" : "منبع: NerkhAra";
    const interval = provider === "Talasanj" ? "به‌روزرسانی تقریبی هر ۲۰ ثانیه" : "به‌روزرسانی تقریبی هر ۱۰ دقیقه";
    reply = (lines.length ? lines.join("\n") : "داده بازار در دسترس نیست.")
      + "\n" + attribution + " | " + interval
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
