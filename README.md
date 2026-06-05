# مراجِع — بنك أسئلتك

تطبيق ويب تعليمي (PWA) لمراجعة المواد الدراسية بالاختبارات والذكاء الاصطناعي.

## البنية
- `index.html` — التطبيق
- `functions/api/ai.js` — دالة الذكاء الاصطناعي (Cloudflare Pages Function)
- `manifest.json`, `sw.js` — إعدادات PWA
- `icon-*.png` — الأيقونات

## النشر
يُنشر تلقائياً على Cloudflare Pages عند كل push.
يحتاج متغير البيئة: `ANTHROPIC_API_KEY`
