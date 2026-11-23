# عیار هوشمند | Ayyar Smart Trader

این مخزن شامل اسکلت بازسازی‌شده بک‌اند و اپلیکیشن اندروید است.

## بک‌اند
از مسیر `backend/` اجرا کنید:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=. uvicorn app.main:app --reload
```

آدرس سلامت: `/health` — مستندات API: `/docs`

## اندروید
پوشه `android/` را در Android Studio باز کنید و Gradle Sync بزنید. برای ساخت نسخه آزمایشی:

```bash
gradle assembleDebug
```

## ساخت خودکار
Workflow در مسیر `.github/workflows/ci.yml` تست‌های بک‌اند را اجرا می‌کند و APK آزمایشی را به‌عنوان Artifact منتشر می‌کند.

## محدودیت‌های ایمنی و داده
- هنوز فید زنده و تأییدشده قیمت طلای جهانی/ایران پیکربندی نشده؛ قیمت حدسی نمایش داده نمی‌شود.
- موتور تحلیل در نبود داده کافی یا تأیید چندزمانه، `NO_TRADE` می‌دهد.
- سفارش واقعی و اتصال بروکر فعال نیست.
- کلیدها و توکن‌ها را در مخزن یا APK قرار ندهید؛ از Secrets/Environment Variables استفاده کنید.
