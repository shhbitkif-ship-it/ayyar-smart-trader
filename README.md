# Gold AI Trader — عیار هوشمند

اسکلت اولیه اپلیکیشن اندروید و API بک‌اند. این نسخه هنوز به فید زنده بازار متصل نیست و APK انتشار‌یافته محسوب نمی‌شود.

## Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```
API docs: http://127.0.0.1:8000/docs

## Android
پوشه `android/` را با Android Studio باز کنید و Gradle Sync انجام دهید.

## ایمنی داده
- بدون منبع معتبر، قیمت زنده نمایش داده نمی‌شود.
- موتور اولیه در نبود داده کافی/تأیید، `NO_TRADE` می‌دهد.
- هیچ سفارش واقعی یا اتصال بروکری در این نسخه وجود ندارد.
- کلیدهای API را در مخزن یا APK قرار ندهید.
