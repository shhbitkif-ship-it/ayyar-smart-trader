# عیار هوشمند | Ayyar Smart Trader

اپلیکیشن اندروید و API اطلاعات بازار طلا برای ایران و بازار جهانی. هدف نمایش قیمت‌های قابل ردیابی است؛ قیمت ساختگی تولید نمی‌شود.

## وضعیت فعلی محصول
- بازار ایران: طلای ۱۸ و ۲۴ عیار، مظنه، سکه امامی، نیم‌سکه، ربع‌سکه و دلار آزاد.
- بازار جهانی: اونس طلا XAU/USD.
- فید فعلی: NerkhAra، دادهٔ عمومی JSON بدون کلید API: https://nerkhara.com/api/v1/latest.json
- فید حدود هر ۱۰ دقیقه به‌روزرسانی می‌شود؛ برای معاملات سریع یا اسکالپ مناسب نیست و قیمت اجرایی بروکر نیست.
- قیمت فقط وقتی LIVE است که مقدار، واحد و زمان به‌روزرسانی معتبر و تازه باشند. در قطع منبع، قیمت ساختگی نمایش داده نمی‌شود.
- واحد نمادهای داخلی باید IRT (تومان) و واحد اونس جهانی USD باشد.
- منبع و زمان هر نرخ در پاسخ API ارائه می‌شود؛ NerkhAra باید به‌عنوان منبع ذکر شود: https://nerkhara.com

## API رایگان Cloudflare Workers
آدرس پایه: https://ayyar-smart-trader-api.ayyar-smart-trader.workers.dev

- سلامت: GET /health
- اعلان‌های بسته‌شدن حساب آزمایشی: GET `/v1/paper/accounts/{account_id}/notifications` با Bearer token؛ رویدادهای بسته‌شدن دستی، حد ضرر و حد سود را برمی‌گرداند.
- گزارش روزانه حساب آزمایشی: GET `/v1/paper/accounts/{account_id}/report/daily` یا با `?date=YYYY-MM-DD`؛ گزارش بر اساس UTC و شامل تعداد برد/باخت، سود/زیان تحقق‌یافته و کارمزدهاست.
- گزارش عملکرد هفتگی/ماهانه: GET `/v1/paper/accounts/{account_id}/report/performance?period=week|month`؛ شامل بازده خالص، نرخ برد، ضریب سود، امید ریاضی، کارمزد، منحنی موجودی تحقق‌یافته و بیشترین افت سرمایه است. محاسبه بر اساس معاملات بسته‌شده و روز UTC انجام می‌شود؛ معاملات باز و افت درون‌روزی در منحنی منظور نمی‌شوند.
- اعلان‌ها فقط داخل برنامه/دفتر حساب ذخیره می‌شوند؛ ارسال Push یا تلگرام برای معاملات آزمایشی در این نسخه فعال نیست.
- قیمت‌ها: GET /v1/market/quotes
- تاریخچه روزانه: GET /v1/market/history?symbol=gold-18k (نمادهای مجاز از فهرست قیمت‌ها)
- وضعیت بازار: GET /v1/market/status\n- کندل‌های بسته‌شده اونس جهانی: GET `/v1/market/candles?symbol=xau&interval=60m`؛ داده از API عمومی XAUS دریافت، OHLC اعتبارسنجی و کندل جاریِ ناقص حذف می‌شود. بازه‌های مجاز: 15m، 30m، 60m و 1d.\n- سیگنال آخر اونس جهانی: GET `/v1/signals/latest?symbol=xau&interval=60m`؛ تحلیل تک‌تایم‌فریمی ۶۰ دقیقه‌ای.\n- رژیم بازار: GET `/v1/market/regime?symbol=xau&interval=60m`؛ بازار را به TRENDING، RANGE، HIGH_VOLATILITY، TRANSITIONAL یا UNAVAILABLE دسته‌بندی می‌کند. آستانه‌های اولیه: ATR بیش از ۱٫۵٪ = نوسان شدید؛ فاصله EMA کمتر از ۰٫۰۴٪ همراه با شیب کمتر از ۰٫۰۰۱۵٪ = رنج. این فیلتر تجربی است و باید با داده تاریخی نماد کالیبره شود.
- سیگنال چندتایم‌فریمی: GET `/v1/signals/multi-timeframe?symbol=xau`؛ صدور BUY/SELL فقط با توافق سیگنال ۱۵ و ۶۰ دقیقه، هم‌جهتی EMA در هر سه بازه و تأیید رژیم TRENDING در ۶۰ دقیقه. رنج، نوسان شدید، بازار انتقالی یا نبود داده باعث `NO_TRADE` می‌شود.
- سیاست ریسک: GET /v1/risk/policy
- محاسبه حجم: POST /v1/risk/position-size
- ارزیابی سیگنال: POST `/v1/signals/evaluate` با بدنه JSON شامل `timeframe_minutes` و آرایه `candles`؛ هر کندل باید `timestamp`, `open`, `high`, `low`, `close` معتبر داشته باشد (حداقل ۶۰ کندل). داده آخر باید تازه باشد. خروجی شامل BUY/SELL/NO_TRADE، امتیاز هم‌جهتی، RSI، MACD، ATR و سطوح پیشنهادی ورود/حدضرر/هدف است؛ اجرای سفارش غیرفعال است.
- بک‌تست آزمایشی EMA20/EMA50: POST `/v1/backtest/ema-crossover` (روی Worker رایگان و API بک‌اند؛ ورودی شامل حداقل ۶۰ کندل OHLC است)
- بک‌تست یک‌کلیکی با کندل‌های واقعی و بسته‌شده XAUS: GET `/v1/backtest/ema-crossover/live?symbol=xau&interval=60m`؛ بازه‌های مجاز 15m، 30m، 60m و 1d هستند. سرمایه اولیه، کارمزد و لغزش با پارامترهای `starting_capital`، `fee_bps` و `slippage_bps` قابل تنظیم‌اند. در نبود داده معتبر، پاسخ UNAVAILABLE می‌دهد و داده ساختگی جایگزین نمی‌کند.
- مقایسه زنده استراتژی‌ها: GET `/v1/backtest/ema-crossover/compare?symbol=xau`؛ سه جفت EMA 9/21، 12/26 و 20/50 روی بازه‌های 15m، 30m، 60m و 1d با هزینه معاملاتی یکسان مقایسه می‌شوند. خروجی شامل بازده، افت سرمایه، تعداد معاملات و درصد برد است. این آزمون long-only و پژوهشی است؛ نمونه‌ها بین تایم‌فریم‌ها هم‌اندازه نیستند.
- اعتبارسنجی خارج از نمونه Walk-forward: GET `/v1/backtest/walk-forward/live?symbol=xau&interval=60m` یا POST `/v1/backtest/walk-forward` با آرایه کندل‌های OHLC. سه پنجره با گسترش داده آموزشی می‌سازد؛ در هر پنجره فقط از گذشته یکی از EMAهای 9/21، 12/26 یا 20/50 انتخاب می‌شود و سپس روی بازه بعدیِ دیده‌نشده آزمون می‌شود. کندل‌های آموزشی فقط برای گرم‌کردن شاخص‌ها استفاده می‌شوند و در سود/زیان آزمون وارد نمی‌شوند. حداقل ۱۸۰ کندل لازم است. نتیجه پژوهشی است و اجرای سفارش غیرفعال می‌ماند.
- آرشیو سیگنال چندتایم‌فریمی اونس: هر بار ارزیابی موفق `/v1/signals/multi-timeframe?symbol=xau` نتیجه را با کلید کندل ۶۰ دقیقه‌ای در Cloudflare KV با نگهداری ۹۰ روزه ثبت می‌کند؛ درخواست‌های تکراری همان کندل را بازنویسی می‌کنند و رکورد تکراری نمی‌سازند. مشاهده سوابق: GET `/v1/signals/history?limit=50` (حداکثر ۱۰۰). خطای ذخیره‌سازی مانع ارائه سیگنال زنده نمی‌شود.
- کارنامه عملکرد سیگنال‌ها: GET `/v1/signals/performance`؛ بازده توصیفی پس از ۱، ۴ و ۲۴ کندل بسته‌شده، با ورود فرضی در بازشدن کندل بعدی. شکاف داده باعث حذف نتیجه همان افق می‌شود؛ کارمزد، اسپرد و لغزش لحاظ نشده و این آمار تضمین سود نیست. 
- هشدار تلگرام اختیاری است: با تنظیم Secrets به نام‌های `BOT_TOKEN`، `SIGNAL_ALERT_CHAT_ID` و `TELEGRAM_WEBHOOK_SECRET`، فقط هنگام تغییر جهت سیگنال تأییدشده BUY/SELL هشدار ارسال می‌شود؛ برای هر کندل هشدار تکراری صادر نمی‌شود. دستورات `/signals` و `/history` نیز آخرین سیگنال و سوابق را نمایش می‌دهند. تا قبل از تنظیم این سه مقدار، هشدار خودکار فعال نیست.
- اپ اندروید بخش «سوابق سیگنال‌های ذخیره‌شده» دارد و سوابق، زمان ثبت، روند، امتیاز همگرایی و سطوح ورود/حدضرر/هدف را نمایش می‌دهد. آرشیو در EU jurisdiction نگهداری می‌شود؛ اجرای سفارش همچنان غیرفعال است.

کد Worker در `cloudflare/worker.js` است. هیچ کلید API یا راز دسترسی در اپلیکیشن یا مخزن ذخیره نشده است.

## اپلیکیشن اندروید
پنل سلامت داده، تعداد و تازگی کندل‌ها و شکاف‌های OHLC را نشان می‌دهد. پنل حساب آزمایشی، سلامت پایش زمان‌بندی‌شده، اعلان‌های درون‌برنامه‌ای بسته‌شدن موقعیت‌ها و گزارش روزانه سود/زیان را نیز نمایش می‌دهد. بخش «کارنامه واقعی سیگنال‌ها» نیز پس از درخواست کاربر، نتایج ۱، ۴ و ۲۴ کندلی آرشیو را از API دریافت می‌کند؛ نتایج ناقص یا دارای شکاف به‌عنوان موفق/ناموفق شمرده نمی‌شوند. 
پروژه Android Studio در پوشهٔ `android` قرار دارد. نسخهٔ در حال توسعه اپلیکیشن 0.9.0 است؛ تاریخچه روزانه، نمودار و EMA20/EMA50، RSI14، MACD و ماشین‌حساب مدیریت ریسک متصل به API را ارائه می‌کند. صفحه اصلی همچنین وضعیت سلامت دادهٔ بازار را نشان می‌دهد: منبع و بازه، تعداد کندل‌های بسته‌شده، سن آخرین کندل، تعداد/اندازه شکاف‌های داده و زمان آخرین کندل. وجود شکاف یا خطای منبع به‌صورت هشدار نمایش داده می‌شود؛ دادهٔ گمشده هرگز ساخته یا پر نمی‌شود. ماشین‌حساب حجم را بر اساس سرمایه، ورود، حد ضرر، ارزش قرارداد و محدودیت زیان روزانه/افت سرمایه تخمین می‌زند؛ سفارش واقعی ثبت نمی‌کند.

## حساب آزمایشی پایدار
- سورس Worker اکنون Durable Object مبتنی بر SQLite را برای هر حساب مجازی تعریف می‌کند؛ حساب‌ها از هم جدا هستند و KV برای موجودی مالی استفاده نمی‌شود. نسخه همگام‌شده با commit `48961b30137f2897b094b5df20c432e472fd5ae7` در 2026-11-26 با موفقیت روی Cloudflare بارگذاری و به ۱۰۰٪ ترافیک منتشر شد؛ bindingهای SQLite و KV نیز در تنظیمات نسخه فعال تأیید شدند.
- ساخت حساب: `POST /v1/paper/accounts` با بدنه اختیاری `{"starting_capital":10000,"currency":"USD"}`. ارزهای پشتیبانی‌شده USD و IRT هستند. توکن دسترسی فقط یک‌بار برگردانده می‌شود؛ فقط هش آن در پایگاه داده ذخیره می‌شود.
- مشاهده موجودی: `GET /v1/paper/accounts/{account_id}` با هدر `Authorization: Bearer <token>`.
- مشاهده دفتر معاملات: `GET /v1/paper/accounts/{account_id}/trades` با همان هدر.
- ایجاد حساب برای هر IP در روز به سه بار محدود شده است. شناسه IP به‌صورت هش‌شده ذخیره می‌شود.
- در سورس فعلی، ثبت و بستن موقعیت آزمایشی، محدودیت ریسک اسمی هر موقعیت، کلید idempotency، پایش حد ضرر/حد سود، اعلان‌ها و گزارش‌های عملکرد پیاده‌سازی و در آزمون‌های Worker بررسی شده‌اند. این قابلیت‌ها را تا زمان انتشار و آزمون نسخه جدید Worker در محیط عملیاتی، فعال و قابل اتکا فرض نکن. سفارش واقعی در تمام نسخه‌ها غیرفعال است.

## شبیه‌ساز معاملات آزمایشی (Paper Trading)
- مسیر آزمایشی: POST `/v1/paper-trading/simulate`
- ورودی JSON شامل آرایه حداقل ۶۰ کندل واقعی OHLC، `starting_capital`، `contract_value_per_price_unit`، `risk_fraction` (حداکثر ۱٪)، `fast_period`، `slow_period`، `fee_bps` و `slippage_bps` است.
- موتور EMA crossover را با ورود در بازشدن کندل بعدی، حدضرر مبتنی بر ATR، هدف ۲R، هزینه رفت‌وبرگشت و گزارش معاملات بسته‌شده، موقعیت باز و منحنی موجودی شبیه‌سازی می‌کند. اگر حدضرر و هدف در یک کندل لمس شوند، نتیجه محافظه‌کارانه حدضرر است.
- خروجی شامل دفتر معاملات، سود/زیان، کارمزد، موجودی مجازی و افت سرمایه است. این endpoint جدا از حساب پایدار است و فقط شبیه‌سازی تاریخیِ بدون‌حالت انجام می‌دهد؛ دفتر حساب پایدار از مسیرهای بخش قبل مدیریت می‌شود.
- این مسیر هیچ سفارش واقعی ثبت نمی‌کند و `execution_enabled=false` باقی می‌ماند. داده ورودی باید OHLC معتبر و واقعی باشد؛ قیمت ساختگی تولید نمی‌شود.

## حساب آزمایشی پایدار و دفتر معاملات

- `POST /v1/paper/accounts` یک حساب مجازی با سرمایه اولیه و ارز `USD` یا `IRT` می‌سازد. توکن Bearer فقط یک بار برگردانده می‌شود و باید محرمانه نگهداری شود.
- `GET /v1/paper/accounts/{account_id}` خلاصه حساب و موجودی را با Bearer token می‌دهد.
- `GET /v1/paper/accounts/{account_id}/trades` دفتر معاملات را برمی‌گرداند.
- `POST /v1/paper/accounts/{account_id}/trades` یک موقعیت فرضی باز می‌کند. بدنه شامل `symbol`، `side`، `quantity`، `entry_price`، `stop_loss`، `take_profit` و `idempotency_key` اختیاری است. حدضرر/هدف باید با جهت معامله سازگار باشد؛ ریسک اسمی هر موقعیت حداکثر ۱٪ موجودی و مجموع ارزش اسمی موقعیت‌های باز حداکثر موجودی حساب است.
- `POST /v1/paper/accounts/{account_id}/trades/{trade_id}/close` با `exit_price` موقعیت را می‌بندد و کارمزد رفت‌وبرگشت را در سود/زیان تحقق‌یافته لحاظ می‌کند.
- `POST /v1/paper/accounts/{account_id}/monitor` آخرین کندل کامل ۱۵ دقیقه‌ای XAUS برای XAU/USD را بررسی می‌کند و اگر حد ضرر یا حد سود در بازه کندل لمس شده باشد، موقعیت آزمایشی را می‌بندد. کندل‌هایی که پیش از بازشدن معامله شروع شده‌اند نادیده گرفته می‌شوند. در برخورد هم‌زمان حد ضرر و هدف، حد ضرر مقدم است؛ در شکاف نامطلوب، قیمت بازشدن کندل مبنای خروج می‌شود.
- پایش زمان‌بندی‌شده Cloudflare نیز با Cron هر ۵ دقیقه فعال است؛ شناسه حساب‌ها در Durable Object ثبت می‌شود و کندل‌های کامل ۱۵ دقیقه‌ای XAUS موجود در پاسخ ارائه‌دهنده به‌صورت ترتیبی برای همه حساب‌ها بررسی می‌شوند تا اجرای ازدست‌رفته تا محدوده تاریخچه ارائه‌دهنده جبران شود. هر کندل برای هر معامله فقط یک‌بار پردازش می‌شود. این پایش فقط موقعیت‌های PAPER_ONLY را می‌بندد و سفارش کارگزاری ارسال نمی‌کند. Cron بر اساس UTC اجرا می‌شود و شروع آن پس از تغییر ممکن است تا ۱۵ دقیقه زمان ببرد. چون منبع، کندل ۱۵ دقیقه‌ای است، تشخیص لمس حدها لحظه‌ای نیست و ممکن است تا بسته‌شدن کندل تأخیر داشته باشد.

- وضعیت آخرین اجرای پایش زمان‌بندی‌شده (موفق، بیکار یا خطا) با زمان اجرا، تعداد حساب‌های بررسی‌شده و تعداد معاملات بسته‌شده در KV ذخیره می‌شود. مسیر عمومی `GET /v1/paper/monitor/status` فقط سلامت کلی موتور را نشان می‌دهد و هیچ شناسه حساب یا اطلاعات محرمانه‌ای برنمی‌گرداند. تاریخچه وضعیت ۳۰ روز نگهداری می‌شود.
- دفتر حساب و موقعیت‌ها در SQLite Durable Object ذخیره می‌شوند. این API فقط شبیه‌سازی است؛ هیچ سفارش واقعی به بروکر یا صرافی ارسال نمی‌شود و `execution_enabled=false` باقی می‌ماند.
- پیش از استفاده، کلید Bearer را در محل امن دستگاه نگهداری کنید؛ هرگز آن را در گزارش‌ها، مخزن Git یا پیام عمومی قرار ندهید.

## کنترل ریسک و محدودیت‌های مهم
- نسخه 0.9.0 یک ماشین‌حساب حجم در اپ دارد که به `/v1/risk/position-size` متصل است. ریسک هر معامله حداکثر ۱٪ است؛ رسیدن زیان روزانه به ۳٪ یا افت سرمایه به ۸٪ محاسبه حجم را مسدود می‌کند. ارزش قرارداد باید متناسب با مشخصات نماد و کارگزاری وارد شود.
- سقف ریسک محاسباتی پیش‌فرض هر معامله ۱٪ سرمایه است؛ حد زیان روزانه ۳٪ و افت سرمایه ۸٪ برای مسدودکردن محاسبه حجم تعریف شده‌اند.
- اتصال کارگزاری و ثبت سفارش واقعی وجود ندارد.
- تاریخچه روزانه از NerkhAra قابل دریافت است؛ هر نقطه میانگین روزانه است، نه کندل OHLC یا داده درون‌روزی. این داده برای تحلیل کوتاه‌مدت و اسکالپ کافی نیست. فید OHLC جدید فقط برای اونس جهانی XAUUSD=X است؛ این نماد شاخص جهانی است و جایگزین فید اختصاصی طلای ۱۸ عیار، مظنه یا سکه ایران نیست.
- موتور ارزیابی تکنیکال API اکنون EMA20/EMA50، RSI14، MACD و ATR14 را برای کندل‌های OHLC واقعی و تازه بررسی می‌کند؛ فیلتر رژیم بازار نیز از ATR نسبی، فاصله EMA و شیب EMA برای پرهیز از بازار رنج و نوسان شدید استفاده می‌کند؛ در صورت نبود داده، داده کهنه یا نبود هم‌جهتی کافی، `NO_TRADE` می‌دهد. امتیاز اطمینان، امتیاز هم‌جهتی شاخص‌هاست و احتمال برد نیست. اپ اندروید مسیر `/v1/signals/multi-timeframe` را برای نمایش هم‌ترازی ۱۵ دقیقه، ۶۰ دقیقه و روزانه، ورود، حد ضرر، هدف و زمان آخرین کندل فراخوانی می‌کند.
- بک‌تست EMA20/EMA50 روی Worker نیز در مسیر `/v1/backtest/ema-crossover` در دسترس است و فقط ابزار تحقیق است: سیگنال در بسته‌شدن کندل تأیید و در بازشدن کندل بعدی اجرا می‌شود؛ کارمزد و لغزش قیمت هر دو سمت معامله لحاظ می‌شوند و سود خالص، نرخ برد، ضریب سود و افت سرمایه گزارش می‌شوند.
- بک‌تست به کندل‌های OHLC معتبر نیاز دارد. تاریخچه روزانه NerkhAra از نوع میانگین روزانه است و نباید به‌عنوان OHLC یا قیمت اجرایی به بک‌تست داده شود.
- این نسخه برای معامله با پول واقعی آماده نیست. نرخ‌های شاخصی و ده‌دقیقه‌ای به‌تنهایی مبنای مطمئنی برای ورود به معامله نیستند.


## دریافت و نصب نسخه آزمایشی اندروید
1. در صفحه [صفحه اجرای ساخت و دریافت APK](https://github.com/shhbitkif-ship-it/ayyar-smart-trader/actions) آخرین اجرای موفق را باز کنید.
2. با حساب GitHub وارد شوید؛ در بخش **Artifacts** فایل `ayyar-smart-trader-debug-apk` را دانلود کنید.
3. فایل ZIP را در گوشی استخراج و فایل `app-debug.apk` را اجرا کنید.
4. اگر اندروید اجازه نصب نداد، فقط برای برنامه‌ای که فایل را با آن باز می‌کنید گزینه **Allow from this source / اجازه از این منبع** را فعال کنید؛ پس از نصب می‌توانید آن را غیرفعال کنید.
5. این خروجی **Debug APK آزمایشی** است، نه نسخه انتشار امضاشده برای فروشگاه. قبل از انتشار عمومی باید نسخه Release با کلید امضای خصوصی امن ساخته شود. کلید امضا نباید داخل مخزن یا چت قرار گیرد.

## آزمون خودکار
GitHub Actions تست‌های بک‌اند، تست‌های Worker با Node.js و ساخت APK آزمایشی اندروید را اجرا می‌کند. Artifact ساخت APK با نام `ayyar-smart-trader-debug-apk` منتشر می‌شود.

## ربات تلگرام (Webhook روی Cloudflare)
- مسیر دریافت به‌روزرسانی‌ها: `POST /telegram/webhook` روی همان Worker.
- فرمان‌ها: `/start`، `/help`، `/gold`، `/iran` و `/market`.
- برای فعال‌سازی، در Cloudflare Worker با نام `ayyar-smart-trader-api` دو Secret با نام‌های `BOT_TOKEN` و `TELEGRAM_WEBHOOK_SECRET` ثبت کنید. مقدار Secret دوم باید یک رشته تصادفی امن باشد.
- سپس Webhook تلگرام را با آدرس `https://ayyar-smart-trader-api.ayyar-smart-trader.workers.dev/telegram/webhook` و همان مقدار `secret_token` ثبت کنید. بدون هر دو Secret، مسیر عمداً با خطای 503 پاسخ می‌دهد.
- توکن ربات را در GitHub، کد برنامه یا پیام‌های عمومی قرار ندهید. این مسیر Webhook جایگزین اجرای دائمی polling و سرویس میزبانی پولی است.


## محدودیت حجم مطابق بروکر
API محاسبه حجم، ورودی‌های اختیاری `lot_step`، `min_lot` و `max_lot` را می‌پذیرد. حجم به سمت پایین تا گام مجاز بروکر گرد می‌شود؛ اگر حجم قابل اجرا کمتر از حداقل بروکر باشد، معامله مسدود می‌شود. این قابلیت فقط تخمین ریسک است و سفارش ارسال نمی‌کند.


### OHLC data-quality checks
- XAUS completed-candle ingestion rejects malformed completed OHLC rows and duplicate timestamps instead of silently treating them as valid.
- Candle gaps are reported with counts and largest missing interval; gaps are never synthetically filled and may reflect market closures.
- Candle freshness and completed-bucket checks remain enforced. Data-quality metadata is exposed by the candles endpoint; all signal/order execution remains disabled.


## Strategy and signal attribution (paper only)

Paper-trade creation accepts optional `strategy_id`, `signal_id`, and `signal_type` (`BUY`, `SELL`, or `NO_TRADE`). These fields are stored only when explicitly supplied; historical trades and trades without metadata remain `UNATTRIBUTED` rather than being matched by approximate timestamps.

Authenticated endpoint: `GET /v1/paper/accounts/{account_id}/analytics/strategy`. It groups closed paper trades by strategy and signal type and reports sample count, win rate, net PnL, fees, profit factor, and expectancy. Advisory risk guidance is withheld until at least 20 closed trades in a group; then negative net PnL or win rate below 35% suggests considering half risk. This is advisory only: it never changes the risk engine, never increases risk, and does not enable live execution. Small samples must not be treated as statistically reliable.


## Duplicate open-position guard

The paper account rejects opening a second position for the same symbol while an existing position on that symbol is still open (HTTP 409). Close the open position first. This avoids accidental stacking or simultaneous opposing positions in the paper journal; it does not place real orders.


## Verified-data historical backtest

`POST /v1/paper-trading/backtest` fetches completed, validated global XAU/USD candles from XAUS, with BIQUOTE as a no-key fallback when XAUS chart freshness metadata is invalid or stale, and runs the existing EMA/ATR paper simulation. The BIQUOTE adapter excludes open bars and validates symbol, interval, timestamps, OHLC consistency, duplicate bars, and freshness before use. Supported intervals are 15m, 60m, and 1d. Example JSON: `{"symbol":"xau","interval":"60m","fast_period":20,"slow_period":50,"starting_capital":10000,"risk_fraction":0.01,"contract_value_per_price_unit":1,"fee_bps":10,"slippage_bps":5}`. The contract value must be selected for the intended instrument sizing; it is not inferred. Response includes provider, last candle timestamp, candle-quality/gap metadata, and a warning about the limited provider history window. This feed is global XAU/USD only, not Iranian gold/coin prices or a broker feed. The backtest is paper-only, does not save account trades, and is not evidence of future performance. For longer-period research, a verified historical dataset is required.


## Alternate XAU/USD candle provider and gap safety

The candle provider chain prefers XAUS chart data and falls back to BIQUOTE XAUUSD OHLC when the primary feed fails freshness or schema checks. BIQUOTE bars marked open are excluded; malformed, duplicate, misaligned, or stale bars are rejected. Gaps are surfaced as GAPS_DETECTED with counts and are never filled or interpolated. The signal engine and scheduled paper monitor remain fail-closed whenever candle history is gapped; the scheduled monitor records the gap count and missing intervals and leaves existing paper positions unchanged. The feed is indicative market data, not a broker execution quote. XAUS and BIQUOTE source attribution is returned with the candle response.


## Signal quality gate

Directional technical confluence is now only a candidate, not an automatic signal. The engine also classifies the completed-candle market regime and blocks BUY/SELL when volatility is excessive, the market is ranging, or trend structure is transitional. Responses expose the proposed direction, final signal, regime metrics, and explicit block reason. A blocked setup returns `NO_TRADE` and zero confidence; the underlying confluence score is reported separately and is not a probability. This is a deterministic safety filter, not a guarantee of better returns. Execution remains disabled.

## Backtest continuity and provider provenance

Historical EMA and walk-forward backtests now validate timestamp continuity before calculating returns. Missing or irregular intervals are rejected rather than bridged; live backtests receive the provider's declared interval, while manually supplied series report when the interval was inferred from timestamps. Multi-timeframe signal responses report the actual provider used for each timeframe, including BIQUOTE fallback reason and source URL, rather than labeling every timeframe as XAUS. Archived signal provenance is provider-neutral and preserves compatibility with older XAUS records. These checks improve traceability and prevent misleading backtest results; they do not establish strategy profitability.

Gap diagnostics also group repeated gaps that begin and end at the same UTC times across different dates. This is only a recurrence report: repeated timing is not proof of a scheduled market closure, so recurring and isolated gaps remain unclassified, visible, and blocking for signal generation and paper monitoring until independently verified.


### Backtest transaction-cost assumptions

EMA backtests and walk-forward evaluations accept `spread_bps` as the **full quoted bid/ask spread** in basis points; the simulator charges half on entry and half on exit. The default is `0` when no spread assumption is supplied, so results without an explicit spread are not spread-adjusted. Existing `fee_bps` and `slippage_bps` remain per-side assumptions. All three inputs are bounded to 0–500 bps. The reported `cost_model` exposes the full spread and per-side half-spread. Supply a conservative, instrument- and broker-specific spread assumption when researching XAUUSD; OHLC backtests still cannot model changing intrabar spreads, market impact, financing, or broker execution. This is research-only and does not enable live orders.


## ممیزی تاریخچه و هزینه‌های بک‌تست

- مسیر پژوهشی `POST /v1/research/data-quality` یک آرایه کندل OHLC و تایم‌فریم `1m|5m|15m|30m|1h|4h|1d` می‌گیرد و تعداد کندل‌ها، تکرار، ترتیب زمانی، فاصله‌های نامنظم و کندل‌های ازدست‌رفته را گزارش می‌کند.
- وضعیت `GAPPED` یعنی بین دو کندل فاصله وجود دارد؛ هیچ کندلی ساخته، درون‌یابی یا بی‌صدا حذف نمی‌شود. تعطیلی آخر هفته یا وقفه سشن نیز خودکار فرض و از گزارش حذف نمی‌شود.
- بک‌تست پایتون پارامتر `spread_bps` را به‌عنوان کل فاصله خرید تا فروش می‌پذیرد؛ نصف آن در هر سمت اعمال می‌شود. کارمزد و لغزش همچنان هزینه‌های هر سمت هستند. مقدار پیش‌فرض اسپرد صفر است و نتیجه بدون ورود فرض اسپرد، اسپردتعدیل‌شده محسوب نمی‌شود.
- برای تاریخچه XAUUSD می‌توان منبعی مانند Dukascopy را جداگانه برای پژوهش بررسی کرد؛ ابزار dukascopy-node مستندات کندل‌های Bid و Ask و تاریخچه XAUUSD را ارائه می‌کند. این منبع به فید زنده Worker متصل نشده و داده‌اش نباید جای قیمت اجرایی بروکر را بگیرد. شرایط استفاده Dukascopy محدودیت‌های استفاده غیرتجاری شخصی و بازنشر دارد؛ پیش از هر استفاده باید شرایط جاری منبع بررسی شود.
- هیچ داده تاریخی شخص ثالثی در این مخزن یا API زنده ذخیره یا بازتوزیع نمی‌شود.

نمونه درخواست ممیزی:

```json
{
  "timeframe": "15m",
  "candles": [
    {
      "timestamp": "2026-11-02T10:00:00Z",
      "open": 3980.1,
      "high": 3982.0,
      "low": 3979.4,
      "close": 3981.2
    },
    {
      "timestamp": "2026-11-02T10:15:00Z",
      "open": 3981.2,
      "high": 3983.0,
      "low": 3980.8,
      "close": 3982.4
    }
  ]
}
```


## Walk-forward market-regime attribution

Each out-of-sample fold reports bars classified as TRENDING, RANGE, HIGH_VOLATILITY, TRANSITIONAL, or UNAVAILABLE. The classifier uses only candles completed before each test candle opens. Equity changes are attributed to the regime known at the start of each bar; trades are grouped by the regime at entry. Fold and aggregate summaries are descriptive diagnostics only, do not change strategy selection, and do not imply that a regime label predicts future returns.

## Walk-forward transaction-cost stress test

Each walk-forward fold repeats its out-of-sample evaluation with the exact same parameters selected on the training window, but with fee, slippage, and full spread assumptions doubled (each capped at the API's 500 bps input limit). No parameter reselection occurs in the stress run. The response reports stressed return and drawdown per fold plus compounded stressed return and the difference from baseline. This is a sensitivity scenario, not a forecast of broker costs or proof of strategy robustness; if a baseline cost input is zero, doubling it remains zero.

## Walk-forward stability diagnostics

The Cloudflare Worker walk-forward response now includes descriptive fold-stability diagnostics: positive/negative fold counts, positive-fold ratio, median fold return, fold-return range, and minimum out-of-sample trades per fold. The sample is marked `INSUFFICIENT_SAMPLE` unless it contains at least 20 out-of-sample trades overall and at least 5 in every fold. Other statuses (`CONSISTENT_POSITIVE`, `CONSISTENT_NEGATIVE`, `MIXED`) describe the observed folds only; they are not statistical proof or a profitability guarantee. The evaluator also rejects invalid, duplicate, or out-of-order timestamps rather than silently sorting user-supplied candles. Gaps and irregular intervals continue to block evaluation. Research only; execution remains disabled.

The Worker walk-forward evaluator includes the first test-window open as an eligible next-open fill using the preceding completed training candle's signal. Open positions are marked with estimated exit-side costs (fee, slippage, and half-spread), including final liquidation value, so reported out-of-sample equity is not overstated by omitting exit costs.
