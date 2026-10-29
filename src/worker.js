// Pharmacy RAG — Cloudflare Worker.
// Port of rag_core.py: same pipeline (classify -> rewrite -> embed -> cosine -> rerank -> answer)
// using the Cohere REST API. The knowledge base ships as static assets (public/kb/*).

const COHERE = "https://api.cohere.com/v2";
const EMBED_MODEL = "embed-multilingual-v3.0"; // must match the model used to build the KB vectors
const RERANK_MODEL = "rerank-multilingual-v3.0";
const CHAT_MODEL = "command-r-plus-08-2024";

const TOP_K = 12;
const FINAL_TOP_N = 4;
const MIN_SIMILARITY = 0.20;
const RERANK_ABSTAIN_THRESHOLD = 0.02;

const MAX_QUESTION_CHARS = 600;
const MAX_HISTORY_TURNS = 5;
const MAX_HISTORY_CHARS = 1200;

const SYSTEM_PROMPT = `You are a careful pharmacy knowledge assistant.

The knowledge base contains:
1. Drug-specific pharmacy information for medications commonly sold/used in Egypt.
2. Selected official Egyptian Drug Authority (EDA) documents (antimicrobial
   prophylaxis, pharmacovigilance, non-prescription/OTC medicines).

Rules:
1. Answer ONLY from the CONTEXT. Never use outside knowledge, even if you are
   confident it's correct.
2. If the requested information is not explicitly in the CONTEXT, say:
   "This information is not available in the knowledge base." Do not guess.
3. Ground each factual claim in the supplied CONTEXT, but DO NOT output
   citations, source tags, document titles, reference lists, or [SOURCE: ...]
   markers in the answer. The user interface shows the retrieved sources
   separately. Do not invent sources.
4. Do not combine separate facts into a new conclusion unless the source
   explicitly connects them. For interactions between two drugs, answer only
   if the CONTEXT explicitly discusses that specific interaction.
5. The knowledge base contains SELECTED EDA documents only — never imply it
   represents the complete Egyptian Drug Authority database.
6. Reply in the SAME language as the user's question. In Arabic, keep precise
   clinical terms precise (e.g. نقص سكر الدم لا "مشكلة في السكر").
7. Be concise: plain sentences or short bullets, no markdown headers, bold
   only for a drug name or a single critical warning.
8. End every answer with a short reminder that this is not a substitute for a
   licensed pharmacist or physician and that patient-specific factors should
   be checked by a professional.
`;

const MSG = {
  outOfScope: "السؤال ده خارج نطاق قاعدة المعرفة (الصيدلة / هيئة الدواء المصرية).",
  notFoundAr: "المعلومة دي مش متوفرة في قاعدة المعرفة.\n\nالأداة دي مش بديل عن استشارة صيدلي أو طبيب مرخّص.",
  notFoundEn: "This information is not available in the knowledge base.\n\nThis information is not a substitute for a licensed pharmacist or physician.",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ index --
let indexPromise = null; // cached per isolate

function loadIndex(env) {
  if (!indexPromise) {
    indexPromise = (async () => {
      const get = (p) => env.ASSETS.fetch(new Request("https://assets.local" + p));
      const [metaRes, vecRes, txtRes] = await Promise.all([
        get("/kb/meta.json"), get("/kb/vectors.f32"), get("/kb/texts.bin"),
      ]);
      if (!metaRes.ok || !vecRes.ok || !txtRes.ok) throw new Error("knowledge base assets missing");
      const meta = await metaRes.json();
      const vectors = new Float32Array(await vecRes.arrayBuffer());
      const texts = new Uint8Array(await txtRes.arrayBuffer());
      if (vectors.length !== meta.count * meta.dim) throw new Error("knowledge base size mismatch");
      return { meta, vectors, texts, decoder: new TextDecoder() };
    })().catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

const chunkText = (idx, i) => {
  const c = idx.meta.chunks[i];
  return idx.decoder.decode(idx.texts.subarray(c.o, c.o + c.l));
};

// ----------------------------------------------------------------- cohere --
async function cohere(env, path, body) {
  const res = await fetch(COHERE + path, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.COHERE_API_KEY}`, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
       console.error(`cohere error ${path} ${res.status} :: ${detail}`);
    if (res.status === 429) throw new HttpError(429, "الخدمة مشغولة حاليًا، جرّب بعد دقيقة.");
    throw new HttpError(502, "حصلت مشكلة في الاتصال بخدمة الذكاء الاصطناعي. جرّب تاني.");
  }
  return res.json();
}

async function callLLM(env, system, user, temperature = 0) {
  const r = await cohere(env, "/chat", {
    model: CHAT_MODEL, temperature, stream: false,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return (r.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function isRagQuestion(env, question) {
  const system =
    "Classify the user question. Return ONLY one word.\n" +
    "YES = related to pharmacy, medications, drug safety/interactions, dosage, OTC medicines, " +
    "adverse drug reactions, pharmacovigilance, antimicrobial prophylaxis, or Egyptian Drug Authority (EDA) documents.\n" +
    "NO = casual conversation, asking about the assistant itself, greetings, general chat, unrelated knowledge.\n" +
    "Return ONLY: YES or NO.";
  return (await callLLM(env, system, question)).trim().toUpperCase().startsWith("YES");
}

async function rewriteQuery(env, question, history) {
  const historyBlock = history.length ? "Previous conversation:\n" + history.join("\n") + "\n\n" : "";
  const system =
    "You rewrite a user's pharmacy question into ONE short, clear, standalone search query, in the SAME language. " +
    "Do not answer the question. Resolve pronouns using the conversation history if given. Output ONLY the rewritten query.";
  const out = await callLLM(env, system, `${historyBlock}Question: ${question}\nRewritten standalone query:`);
  return out.trim().replace(/^"|"$/g, "") || question;
}

// -------------------------------------------------------------- retrieval --
async function retrieve(env, idx, query) {
  const r = await cohere(env, "/embed", {
    texts: [query], model: EMBED_MODEL, input_type: "search_query", embedding_types: ["float"],
  });
  const q = Float32Array.from(r.embeddings.float[0]);
  let norm = 0; for (let k = 0; k < q.length; k++) norm += q[k] * q[k];
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < q.length; k++) q[k] /= norm;

  const { dim, count } = idx.meta;
  if (q.length !== dim) throw new Error("embedding dimension mismatch");
  const sims = new Float32Array(count);
  const v = idx.vectors;
  for (let i = 0; i < count; i++) {
    let s = 0, base = i * dim;
    for (let k = 0; k < dim; k++) s += v[base + k] * q[k];
    sims[i] = s;
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => sims[b] - sims[a]).slice(0, TOP_K);
  return order.filter((i) => sims[i] >= MIN_SIMILARITY).map((i) => ({ i, similarity: sims[i] }));
}

async function rerank(env, idx, query, hits) {
  if (!hits.length) return [];
  const r = await cohere(env, "/rerank", {
    model: RERANK_MODEL, query,
    documents: hits.map((h) => chunkText(idx, h.i)),
    top_n: Math.min(FINAL_TOP_N, hits.length),
  });
  return r.results
    .map((x) => ({ ...hits[x.index], rerank: x.relevance_score }))
    .sort((a, b) => b.rerank - a.rerank);
}

function buildContext(idx, hits) {
  const seen = new Set(), blocks = [];
  for (const h of hits) {
    const m = idx.meta.chunks[h.i];
    let section = m.s || "";
    if (section.includes(",")) section = section.split(",")[0].trim();
    const key = [m.t, m.h, m.d, section].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = m.t === "eda" ? `[SOURCE: EDA | ${m.h} | Section: ${section}]`
      : m.t === "drug_knowledge" ? `[SOURCE: Drug Knowledge Base | ${m.d} — ${section}]`
      : `[SOURCE: ${m.h} | ${section}]`;
    blocks.push(`${tag}\n${chunkText(idx, h.i)}`);
  }
  return blocks.join("\n\n---\n\n");
}

function sourcesFor(idx, hits) {
  const seen = new Set(), out = [];
  for (const h of hits) {
    const m = idx.meta.chunks[h.i];
    const label = m.h || m.d || "مصدر غير محدد";
    let section = (m.s || "").split(",")[0].trim();
    const key = label + "|" + section;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label.replace(/\.md$/i, "").replace(/_/g, " "), section, type: m.t });
  }
  return out;
}

const stripSourceTags = (a) =>
  a.replace(/\[\s*SOURCE\s*:[\s\S]*?\]/gi, "").replace(/[ \t]+(?=\n)/g, "")
    .replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// --------------------------------------------------------------- pipeline --
async function ragQuery(env, question, history) {
  const hasArabic = /[؀-ۿ]/.test(question);
  const notFound = hasArabic ? MSG.notFoundAr : MSG.notFoundEn;

  if (!(await isRagQuestion(env, question))) return { answer: MSG.outOfScope, sources: [], abstained: true };

  const idx = await loadIndex(env);
  const searchQuery = history.length || question.split(/\s+/).length <= 3
    ? await rewriteQuery(env, question, history) : question;

  const hits = await retrieve(env, idx, searchQuery);
  if (!hits.length) return { answer: notFound, sources: [], abstained: true };

  const top = await rerank(env, idx, searchQuery, hits);
  if (!top.length || Math.max(...top.map((h) => h.rerank)) < RERANK_ABSTAIN_THRESHOLD) {
    return { answer: notFound, sources: [], abstained: true };
  }

  const languageInstruction = hasArabic
    ? "The user's question is written in ARABIC. You MUST write your entire answer in Arabic (including the safety reminder at the end). Do not switch to English."
    : "The user's question is written in ENGLISH. You MUST write your entire answer in English (including the safety reminder at the end). Do not switch to Arabic.";
  const userPrompt =
    `CONTEXT:\n${buildContext(idx, top)}\n\nQUESTION: ${question}\n\n${languageInstruction}\n\n` +
    "Use the context as evidence, but do NOT include source tags or citations in the visible answer. Sources appear separately in the UI.\n\nANSWER:";
  const answer = stripSourceTags(await callLLM(env, SYSTEM_PROMPT, userPrompt));
  return { answer, sources: sourcesFor(idx, top), abstained: false };
}

// ---------------------------------------------------------------- handler --
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

async function handleChat(request, env) {
  if (!env.COHERE_API_KEY) return json({ error: "الخدمة غير مهيّأة: COHERE_API_KEY ناقص." }, 500);

  if (env.RATE_LIMITER) { // optional binding, see README
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "عدد الأسئلة كبير، استنى شوية وجرّب تاني." }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "طلب غير صالح." }, 400); }
  const question = String(body?.question ?? "").trim();
  if (!question) return json({ error: "اكتب سؤالك الأول." }, 400);
  if (question.length > MAX_QUESTION_CHARS) return json({ error: `السؤال طويل، الحد الأقصى ${MAX_QUESTION_CHARS} حرف.` }, 400);

  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => `${m.role}: ${m.content.slice(0, MAX_HISTORY_CHARS)}`);

  try {
    return json(await ragQuery(env, question, history));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("chat failure", e);
    return json({ error: "حصلت مشكلة غير متوقعة. جرّب تاني." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return handleChat(request, env);
    }
    if (url.pathname.startsWith("/kb/")) return new Response("Not found", { status: 404 }); // KB is internal only
    return env.ASSETS.fetch(request);
  },
};
