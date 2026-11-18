import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { getStore } from "@netlify/blobs";

const FREE_CHECKS_PER_DAY = 3;

const MODELS = [
  { id: "chatgpt", label: "ChatGPT", run: async (prompt) => {
      const c = new OpenAI();
      const r = await c.responses.create({ model: "gpt-6-luna", input: prompt, reasoning: { effort: "none" }, max_output_tokens: 500 });
      return r.output_text || "";
  }},
  { id: "claude", label: "Claude", run: async (prompt) => {
      const c = new Anthropic();
      const r = await c.messages.create({ model: "claude-haiku-5-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] });
      return (r.content || []).map((b) => b.text || "").join("");
  }},
  { id: "gemini", label: "Gemini", run: async (prompt) => {
      const c = new GoogleGenAI({});
      const r = await c.models.generateContent({ model: "gemini-flash-lite-latest", contents: prompt });
      return r.text || "";
  }},
];

const clean = (s, n = 80) => String(s || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);

function buyerPrompts(category, city) {
  const where = city ? ` in ${city}` : "";
  return [
    `What are the best ${category}${where}? Give me a short list of specific names.`,
    `Can you recommend a good ${category}${where}? Name a few and say why.`,
    `I'm comparing ${category} options${where}. Which ones should I look at first?`,
    `Who are the top-rated ${category}${where} right now?`,
  ];
}

function nameVariants(business, website) {
  const v = new Set();
  const base = business.toLowerCase().replace(/[^\p{L}\p{N}\s&'-]/gu, " ").replace(/\s+/g, " ").trim();
  if (base.length >= 3) v.add(base);
  const stripped = base.replace(/\b(inc|llc|ltd|co|corp|company|the|株式会社|有限会社)\b/g, "").replace(/\s+/g, " ").trim();
  if (stripped.length >= 3) v.add(stripped);
  if (website) {
    const host = website.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (host.includes(".")) { v.add(host); const root = host.split(".")[0]; if (root.length >= 4) v.add(root); }
  }
  return [...v];
}

function findMention(text, variants) {
  const t = text.toLowerCase();
  let best = -1;
  for (const v of variants) { const i = t.indexOf(v); if (i >= 0 && (best < 0 || i < best)) best = i; }
  if (best < 0) return { mentioned: false };
  // position = how many list items appear before the first mention
  const before = text.slice(0, best);
  const items = (before.match(/^\s*(\d+[.)]|[-*•])\s+/gm) || []).length;
  // the list marker of the item containing the mention is already counted
  return { mentioned: true, position: Math.max(1, items) };
}

async function json(model, prompt) {
  const c = new OpenAI();
  const r = await c.responses.create({ model, input: prompt, reasoning: { effort: "none" }, max_output_tokens: 900 });
  const txt = (r.output_text || "").replace(/^```(json)?|```$/gm, "").trim();
  return JSON.parse(txt);
}

export default async (req, context) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request" }, { status: 400 }); }
  const business = clean(body.business), category = clean(body.category, 60), city = clean(body.city, 60), website = clean(body.website, 120);
  if (business.length < 2 || category.length < 2) return Response.json({ error: "Enter your business name and what you do." }, { status: 400 });

  // simple per-visitor daily limit
  const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  let store;
  try {
    store = getStore("rate");
    const key = `${day}:${ip}`;
    const used = Number((await store.get(key)) || 0);
    if (used >= FREE_CHECKS_PER_DAY) return Response.json({ error: "You've used today's free checks. Come back tomorrow, or get weekly tracking with Pro." }, { status: 429 });
    await store.set(key, String(used + 1));
  } catch { /* blobs unavailable: skip limit */ }

  if (!process.env.OPENAI_BASE_URL) return Response.json({ error: "AI service not active yet." }, { status: 503 });

  const prompts = buyerPrompts(category, city);
  const variants = nameVariants(business, website);

  const jobs = [];
  for (const m of MODELS) for (const p of prompts) {
    jobs.push(m.run(p).then((answer) => ({ model: m.id, label: m.label, prompt: p, answer, ...findMention(answer, variants) }))
      .catch(() => ({ model: m.id, label: m.label, prompt: p, answer: "", error: true })));
  }
  const results = await Promise.all(jobs);
  const ok = results.filter((r) => !r.error);
  if (!ok.length) return Response.json({ error: "The AI models didn't answer. Please try again in a minute." }, { status: 502 });

  const hits = ok.filter((r) => r.mentioned).length;
  const score = Math.round((hits / ok.length) * 100);
  const byModel = MODELS.map((m) => {
    const rs = ok.filter((r) => r.model === m.id);
    return { id: m.id, label: m.label, asked: rs.length, mentioned: rs.filter((r) => r.mentioned).length };
  }).filter((m) => m.asked);

  // competitors that AI recommends instead + tailored fixes (one cheap call)
  let competitors = [], fixes = [];
  try {
    const sample = ok.map((r) => `[${r.label}] ${r.answer.slice(0, 900)}`).join("\n---\n").slice(0, 14000);
    const out = await json("gpt-6-luna",
`A business wants AI assistants (ChatGPT, Claude, Gemini) to recommend it.
Business: "${business}". What it does: "${category}". Location: "${city || "not given"}". Website: "${website || "not given"}".
Its visibility score is ${score}/100 (mentioned in ${hits} of ${ok.length} AI answers).
Here are the AI answers:
${sample}

Return ONLY JSON: {"competitors":[{"name":string,"count":number}],"fixes":[{"title":string,"detail":string}]}
- competitors: the specific business/brand names recommended in these answers (not "${business}"), with how many answers mention each, most frequent first, max 8.
- fixes: exactly 5 concrete, specific actions this business can take in the next 30 days so AI assistants start recommending it (e.g. which listing sites, review platforms, comparison articles, Reddit/forum threads, structured data, pages to create). Tailor to the category and location. Each detail max 40 words.`);
    competitors = Array.isArray(out.competitors) ? out.competitors.slice(0, 8) : [];
    fixes = Array.isArray(out.fixes) ? out.fixes.slice(0, 5) : [];
  } catch { /* optional */ }

  try {
    const leads = getStore("checks");
    await leads.set(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ business, category, city, website, score, at: new Date().toISOString() }));
  } catch {}

  return Response.json({
    business, category, city, score, hits, total: ok.length, byModel, competitors, fixes,
    answers: ok.map((r) => ({ label: r.label, prompt: r.prompt, mentioned: r.mentioned, position: r.position || null, excerpt: r.answer.slice(0, 600) })),
  });
};

export const config = { path: "/api/check", method: "POST" };
