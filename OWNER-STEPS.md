# خطوات المالك (قصيرة)

## أ) إنشاء المستودع (مرة وحدة — إذا ما سويته)
1. https://github.com/new ← **Repository name**: `miqdar-desktop` ← **Public** ← لا تعلّم أي خيار ← **Create repository**. بعدها قول للأم «جاهز».

## ب) نشر إصدار جديد (ويندوز + ماك) — بعد ما الأم ترفع الكود
1. افتح https://github.com/shokryalraee/miqdar-desktop/releases/new
2. **Choose a tag** ← اكتب `v1.1.0` ← **Create new tag**
3. **Release title**: `v1.1.0` ← **Publish release**
4. افتح تبويب **Actions**: يبني ويندوز وماك (حوالي 10 دقايق) ويرفع الملفات للـRelease لوحده (`Miqdar-Setup-x64.exe`, `Miqdar-x64.dmg`, `Miqdar-arm64.dmg`).
5. تأكد في صفحة الـRelease إن الملفات الثلاثة موجودة، وبعدها أزرار «حمّل التطبيق» في الموقع تشتغل.

## ج) أول مرة تفتح التطبيق: تحذير «غير موثوق»؟ هذا طبيعي (التطبيق غير موقّع)
**ويندوز** (شاشة «Windows protected your PC»): اضغط **مزيد من المعلومات (More info)** ← **تشغيل على أي حال (Run anyway)**.
**ماك** («لا يمكن فتحه لأن المطوّر غير معروف»): كليك يمين على التطبيق ← **فتح (Open)** ← **فتح** مرة ثانية. (لو ظهرت «ملف تالف»: إعدادات النظام ← الخصوصية والأمان ← «فتح على أي حال».)

هالتحذير **ما يختفي إلا بالتوقيع**: شهادة توقيع ويندوز (Code Signing) + حساب Apple Developer (99$/سنة) لماك. لما تشتريهم تحط الأسرار في إعدادات المستودع ← Settings ← Secrets and variables ← Actions (وتخبر الأم، ما تكتبها في أي شات):
`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (ويندوز) · `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD` + `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (ماك + notarize). الـworkflow يفعّل التوقيع لحاله لما تتوفر.
