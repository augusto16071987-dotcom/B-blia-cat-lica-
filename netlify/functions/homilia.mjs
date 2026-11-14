// Homilia do dia: a IA Gemini (Google) escreve uma reflexão a partir das leituras da Missa do dia.
// É gerada UMA vez por dia e guardada; todos os usuários recebem o mesmo texto (custo quase zero).
// Precisa da variável GEMINI_KEY no Netlify (chave criada no Google AI Studio).
import { getStore } from "@netlify/blobs";

const LIT = "https://liturgia.up.railway.app/v2/";
const KEY = process.env.GEMINI_KEY;
// Modelos rápidos (o Netlify grátis corta a função em 10 segundos). Se um sair de linha, usa o próximo.
const MODELS = [process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-2.5-flash-lite"].filter(Boolean);

const json = (obj, status = 200, cache = "public, max-age=1800") =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": cache } });

async function fetchT(url, opts = {}, ms = 9000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal, headers: { "User-Agent": "BibliaCatolicaApp/1.0", ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

const NOMES = { primeiraLeitura: "Primeira leitura", salmo: "Salmo responsorial", segundaLeitura: "Segunda leitura", evangelho: "Evangelho" };
const clean = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

// Pega as leituras do dia (texto completo) na API Liturgia Diária
async function leituras(iso) {
  const [y, m, d] = iso.split("-");
  const r = await fetchT(`${LIT}?dia=${+d}&mes=${+m}&ano=${y}`, {}, 4000);
  if (!r.ok) throw new Error("liturgia " + r.status);
  let j = await r.json(); if (Array.isArray(j)) j = j[0];
  const L = j.leituras || {};
  const out = [];
  for (const k of ["primeiraLeitura", "salmo", "segundaLeitura", "evangelho"]) {
    const it = (L[k] || [])[0];
    if (!it) continue;
    const texto = clean((it.refrao ? "Refrão: " + it.refrao + "\n" : "") + (it.texto || ""));
    if (texto) out.push({ tipo: NOMES[k], ref: clean(it.referencia), titulo: clean(it.titulo), texto });
  }
  if (!out.some(x => x.tipo === "Evangelho")) throw new Error("sem_evangelho");
  return { liturgia: clean(j.liturgia), cor: clean(j.cor), leituras: out };
}

function prompt(dia) {
  const lt = dia.leituras.map(l => `### ${l.tipo} (${l.ref})${l.titulo ? " — " + l.titulo : ""}\n${l.texto}`).join("\n\n");
  return `Você é um sacerdote católico brasileiro, fiel ao Magistério da Igreja e ao Catecismo da Igreja Católica.
Escreva a homilia da Missa de hoje: ${dia.liturgia}.

Leituras do dia:
${lt}

Como escrever:
- Em português do Brasil, linguagem simples, calorosa e pastoral, para o povo de Deus.
- Comece pelo Evangelho e ligue com as outras leituras.
- Explique o sentido do texto e traga para a vida concreta das famílias, do trabalho e da oração.
- Entre 380 e 500 palavras, em 5 ou 6 parágrafos.
- Não invente citações de Papas, santos ou documentos. Cite apenas trechos das leituras acima.
- Sem títulos, sem listas, sem markdown, sem asteriscos.
- Termine com uma breve oração e "Amém."`;
}

async function gerar(dia, deadline) {
  let lastErr = "";
  for (const model of MODELS) {
    const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt(dia) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
      }),
    }, Math.max(2000, deadline - Date.now()));
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 || r.status === 400 && /model/i.test(j.error?.message || "")) { lastErr = model + ": " + (j.error?.message || r.status); continue; }
    if (!r.ok) throw new Error("gemini " + r.status + ": " + (j.error?.message || ""));
    const txt = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    if (!txt) { lastErr = model + ": resposta vazia (" + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "?") + ")"; continue; }
    const par = txt.replace(/\*+/g, "").replace(/^#+\s*/gm, "").split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean);
    return { paragrafos: par, modelo: model };
  }
  throw new Error(lastErr || "sem_modelo");
}

const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

export default async (req) => {
  const u = new URL(req.url);
  const hoje = hojeBR();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("d") || "") ? u.searchParams.get("d") : hoje;
  // só gera de ontem até daqui a 2 dias (evita abuso e custo)
  const diff = (Date.parse(iso) - Date.parse(hoje)) / 864e5;
  if (!(diff >= -1 && diff <= 2)) return json({ error: "data_fora" }, 400, "no-store");
  try {
    const store = getStore("homilia");
    const k = "h:" + iso;
    const hit = await store.get(k, { type: "json" }).catch(() => null);
    if (hit) return json(hit, 200, "public, max-age=3600");
    if (!KEY) return json({ error: "sem_chave" }, 503, "no-store");
    const deadline = Date.now() + 9300;
    // as leituras ficam guardadas: se a IA demorar, a segunda tentativa já começa com elas prontas
    let dia = await store.get("l:" + iso, { type: "json" }).catch(() => null);
    if (!dia) { dia = await leituras(iso); await store.setJSON("l:" + iso, dia).catch(() => {}); }
    const h = await gerar(dia, deadline);
    const out = { date: iso, liturgia: dia.liturgia, cor: dia.cor, leituras: dia.leituras.map(l => ({ tipo: l.tipo, ref: l.ref })), ...h };
    await store.setJSON(k, out).catch(() => {});
    return json(out, 200, "public, max-age=3600");
  } catch (e) {
    return json({ error: "falha", detail: String(e.message || e) }, 502, "no-store");
  }
};

export const config = { path: "/api/homilia" };
