# مساعد الصيدلية الذكي — نسخة Cloudflare

Cloudflare Worker (منطق الـ RAG) + واجهة static. نفس خطوات التطبيق القديم: تصنيف السؤال ← إعادة صياغة ← embedding ← بحث cosine ← rerank ← إجابة، كلها عن طريق Cohere API.

## النشر (مرة واحدة)

1. ثبّت Node.js 20+ من nodejs.org.
2. افتح الـ terminal في فولدر المشروع:
   ```bash
   npm install
   npx wrangler login          # يفتح المتصفح لتسجيل الدخول بحساب Cloudflare
   npx wrangler secret put COHERE_API_KEY   # الصق مفتاح Cohere لما يسألك
   npm run deploy
   ```
3. في آخر الأمر هيطلعلك رابط بالشكل `https://pharmacy-rag.<اسمك>.workers.dev` — دا الموقع.

> أول `wrangler secret put` قبل أول deploy ممكن يسألك "Create a new Worker?" — اختار Yes.

## تجربة محلية
```bash
cp .dev.vars.example .dev.vars   # حط COHERE_API_KEY جواه
npm run dev                      # http://localhost:8787
```

## تحديث قاعدة المعرفة
لو غيّرت `kb_index.json` (تصدير جديد من النوت بوك):
```bash
cp /path/to/kb_index.json scripts/kb_index.json
pip install numpy
npm run build:kb
npm run deploy
```
لازم نفس موديل الـ embedding (`embed-multilingual-v3.0`) يكون هو المستخدم في التصدير.

## ملاحظات مهمة
- **حماية المفتاح من الاستهلاك:** الموقع عام، فأي حد معاه الرابط يقدر يستهلك رصيد Cohere. فعّل Rate Limiting: شيل التعليق عن قسم `ratelimits` في `wrangler.jsonc` ثم `npm run deploy` (10 طلبات/دقيقة لكل IP). ولو الموقع خاص، حطه ورا Cloudflare Access (Zero Trust → Access → Applications).
- **مفتاح Cohere Trial** محدود (حوالي 20 طلب/دقيقة و1000 طلب/شهر، وللاستخدام غير التجاري). كل سؤال بيعمل 4–5 استدعاءات، فللاستخدام الفعلي استخدم Production key.
- **Workers Free:** حد الـ CPU 10ms للطلب. البحث في الـ 1702 chunk بياخد بضع ms، وغالبًا كفاية، لكن لو ظهر خطأ 1102 (CPU exceeded) اشترك في Workers Paid ($5/شهر).
- ملفات قاعدة المعرفة (`public/kb/`) مش متاحة للتحميل من الإنترنت؛ الـ Worker بيرفض أي طلب على `/kb/*`.
- المحادثة بتتخزن في المتصفح (الذاكرة) بس، ومفيش أي حاجة بتتسجل في السيرفر.
- دومين خاص: Cloudflare Dashboard → Workers & Pages → pharmacy-rag → Settings → Domains & Routes.
