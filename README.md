# مقدار كاشير — Miqdar Cashier (Windows + macOS, Electron)
يفتح https://app.miqdarerp.com ويطبع بصمت على الطابعة بالاسم عبر `window.MiqdarNative` (بدون QZ Tray). المحوّل في الويب: `web/native-print.js`.

## تشغيل/بناء
```
cd desktop && npm install
npm test                 # اختبار وحدة لحارس الأصل والحدود (node:test)
npm start                # تشغيل محلي
npm run dist:win         # dist/Miqdar-Setup-x64.exe (يُبنى على ويندوز)
npm run dist:mac         # dist/Miqdar-x64.dmg + Miqdar-arm64.dmg + zip (يُبنى على ماك)
npm run icons            # يولّد icon.ico/icns من build/icon.png (شعار مقدار 1024)
```
متغيرات: `MIQDAR_URL` (الرابط، لازم نطاق مقدار)، `MIQDAR_HOSTS` (نطاقات إضافية مفصولة بفاصلة)، `MIQDAR_DEV=1` (يسمح بـ http://localhost للتطوير فقط).
الإعدادات غير السرية (شاشة كاملة، تشغيل مع ويندوز، الرابط) في `%APPDATA%/…/miqdar-config.json`. لا أسرار تُخزَّن.

## الأمان
`contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`. الـpreload يعرّف `MiqdarNative` فقط لو أصل الصفحة https على `miqdarerp.com` أو نطاق فرعي، والـmain يعيد فحص أصل المرسل في كل نداء. الروابط الخارجية تُفتح في المتصفح، والتنقل خارج النطاقات ممنوع، وكل الصلاحيات (كاميرا/موقع…) مرفوضة.
الواجهة: `version` · `printers()` · `print({html|pdfBase64|url, printer, type:'invoice'|'a4'|'label', paper:{w_mm,h_mm}|'A4', copies, margins})` · `netPost({url,body})` (لطابعات الشبكة LAN فقط: IPv4 خاص + مسارين ثابتين). الملصق بدون اسم طابعة مرفوض دائماً. A4: HTML يطبع بـ`webContents.print`، و`pdfBase64` عبر `pdf-to-printer`.

## التحديث التلقائي
`electron-updater` من GitHub Releases في المستودع **العام** `shokryalraee/miqdar-desktop` عند كل تشغيل للنسخة المثبّتة (المستودع الخاص ما ينفع: التحديث يحتاج توكن).

## ماك: الطباعة الصامتة بالاسم
`webContents.print({silent:true, deviceName})` يشتغل على ماك، والاسم لازم يكون **اسم النظام** (مثل `EPSON_TM_T20`) مو الاسم الودّي؛ و`printers()` ترجّع `name` من `getPrintersAsync()` وهو اسم النظام أصلاً. الـPDF على ماك/لينكس عبر `lp` (CUPS). مراجعة كود فقط: ما جُرّب على ماك حقيقي.

## عن «إشعار كأنه خطأ» عند فتح التطبيق (فحص الكود)
مافي `dialog.showErrorBox` ولا أي نافذة ثانية ولا إشعار من تطبيقنا. نظّفنا: (١) التحديث التلقائي صار صامت (بدل `checkForUpdatesAndNotify` اللي يعرض إشعار ويندوز) وأخطاؤه تُبلع، (٢) `setAppUserModelId` عشان هوية ويندوز صحيحة، (٣) لو ما في إنترنت تظهر صفحة هادئة بزر إعادة المحاولة بدل شاشة بيضاء، (٤) صلاحيات الـpreload الـsandboxed: كان `require('./lib/guard')` يفشل داخل الـsandbox (فكان `MiqdarNative` ما يظهر) فتم تضمين القاعدة في الـpreload وأضفنا اختبار `test/preload.test.js` يشغّله بنفس القيد.
**اللي نحلّه:** كل ما سبق. **اللي ما يختفي إلا بالتوقيع:** شاشة SmartScreen في ويندوز («Windows protected your PC») وتحذير Gatekeeper في ماك — هذي من النظام لأي تطبيق غير موقّع، والأرجح هي مصدر الإشعار اللي شافه المالك. ما قدرنا نجرّب على ويندوز حقيقي من الحاوية.

## التوقيع (جاهز، يتفعّل بالأسرار)
الـworkflow يقرأ أسرار اختيارية ويفعّل التوقيع لحاله: ويندوز `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`، ماك `MAC_CSC_LINK`/`MAC_CSC_KEY_PASSWORD` + notarize بـ`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. بدونها يبني غير موقّع (الوضع الحالي). التحديث التلقائي على ماك يحتاج تطبيق موقّع؛ لين ذاك التحديث يدوي.

## أسماء الملفات الثابتة (لروابط الموقع)
`Miqdar-Setup-x64.exe` · `Miqdar-x64.dmg` (Intel) · `Miqdar-arm64.dmg` (Apple Silicon) → `https://github.com/shokryalraee/miqdar-desktop/releases/latest/download/<الاسم>`.

## الإصدار (CI)
هذا المجلد **مستقل بالكامل** (ما يستورد شي من خارجه) ويعيش كمستودع عام `shokryalraee/miqdar-desktop`. `.github/workflows/build.yml` يبني matrix على `windows-latest` و`macos-latest` بالـ`GITHUB_TOKEN` الافتراضي: دفع tag بصيغة `v1.0.0` ينشر Release فيه الـ.exe والـdmg/zip و`latest*.yml` (لازم للتحديث التلقائي)؛ ويدوياً (workflow_dispatch) يرفع artifact فقط. خطوات المالك: `OWNER-STEPS.md`.
**مراجعة الافتراض «لا أسرار ولا منطق خاص»:** الكود يغلّف تطبيق الويب العام فقط؛ ما فيه مفاتيح ولا توكنات (الإعدادات المحلية: رابط وشاشة كاملة وتشغيل تلقائي)، ولا منطق أعمال: الفواتير والبيانات كلها على الخادم خلف تسجيل الدخول. اللي ينكشف بالمستودع العام: أسماء النطاقات المسموحة وقواعد التحقق فقط، وهذا مو سر. فحصت `desktop/` بـgrep على key/token/secret/supabase قبل النشر.

## بدون توقيع كود (مبدئياً)
ويندوز SmartScreen يعرض (وماك: كليك يمين ← فتح) «Windows protected your PC»: اضغط **More info** ثم **Run anyway**. التحديث التلقائي يشتغل بدون توقيع لكن SmartScreen قد يحذّر لكل إصدار جديد. شهادة التوقيع بند ينتظر المالك (BOARD §5).

## قائمة فحص المالك على جهاز ويندوز حقيقي (٦ خطوات)
1. ثبّت `Miqdar-Cashier-Setup-*.exe` (تخطَّ SmartScreen كما فوق) وافتح التطبيق: يظهر تسجيل دخول مقدار.
2. الإعدادات ← الطباعة ← تشخيص الطباعة: يظهر «✓ تطبيق مقدار كاشير شغّال v…» وقائمة طابعات ويندوز كلها.
3. اختر طابعة الفواتير و A4 والملصقات واضغط «طباعة تجربة» لكل واحدة: تطبع **بدون نافذة** على الطابعة الصحيحة وبالمقاس الصحيح (80/58مم، A4، ملصق).
4. اعمل فاتورة بيع: تنطبع تلقائياً على طابعة الفواتير فقط؛ اطبع ملصق باركود: يروح لطابعة الملصقات فقط (جرّب إلغاء اختيار طابعة الملصقات: لازم يرفض ويطلب الاختيار).
5. قائمة التطبيق: فعّل «شاشة كاملة» و«تشغيل مع ويندوز»، أعد تشغيل الجهاز وتأكد أنه يفتح لوحده.
6. (لو عندك Epson TM-m30/TM-T88VI على الشبكة) أضف «طابعة شبكة» بعنوان IP واطبع تجربة؛ وجرّب الضغط على رابط خارجي داخل النظام: يفتح في المتصفح مو داخل التطبيق.
