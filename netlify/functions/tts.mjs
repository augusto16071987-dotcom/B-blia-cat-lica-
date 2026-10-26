// Voz fixa do app: gera o áudio de cada capítulo UMA vez no Google Text-to-Speech
// e guarda no Netlify Blobs. Depois disso, todo mundo ouve o áudio guardado (sem novo custo).
//
// Variáveis de ambiente no Netlify:
//   GOOGLE_TTS_KEY  -> chave de API do Google Cloud (obrigatória)
//   TTS_VOICE       -> nome da voz (opcional, padrão pt-BR-Neural2-B, masculina)
import { getStore } from "@netlify/blobs";

const VOICE = process.env.TTS_VOICE || "pt-BR-Neural2-B";
const KEY = process.env.GOOGLE_TTS_KEY;
const MAX_BYTES = 4500;          // limite do Google é 5000 bytes por pedido
const SAMPLE = "O Senhor é meu pastor, nada me faltará. Em verdes prados me faz descansar.";

// Vozes que o app pode usar: só pt-BR dos tipos Standard, WaveNet e Neural2
// (as outras, como Studio, são muito mais caras ou não marcam o tempo dos versículos)
const ALLOWED = /^pt-BR-(Standard|Wavenet|Neural2)-[A-Z]$/;
let VOICES = null;
async function voiceList() {
  if (VOICES) return VOICES;
  const r = await fetch("https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR&key=" + encodeURIComponent(KEY));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Google voices " + r.status + ": " + (j.error && j.error.message || "erro"));
  VOICES = (j.voices || []).filter(v => ALLOWED.test(v.name))
    .map(v => ({ name: v.name, gender: v.ssmlGender, type: v.name.split("-")[2] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return VOICES;
}
async function pickVoice(req) {
  if (!req || req === VOICE) return VOICE;
  const list = await voiceList();
  return list.some(v => v.name === req) ? req : VOICE;
}

let BIBLE = null;
async function bible(origin) {
  if (!BIBLE) {
    // o texto pode estar em biblia.json ou embutido no index.html
    const r = await fetch(origin + "/biblia.json");
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) BIBLE = await r.json();
    else {
      const h = await (await fetch(origin + "/index.html")).text();
      const a = h.indexOf('<script type="application/json" id="bible-data">');
      if (a < 0) throw new Error("texto da Bíblia não encontrado");
      const start = h.indexOf(">", a) + 1, end = h.indexOf("</script>", start);
      BIBLE = JSON.parse(h.slice(start, end));
    }
  }
  return BIBLE;
}

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const bytes = s => Buffer.byteLength(s, "utf8");

// Divide o capítulo em pedaços que cabem no limite, sempre entre versículos.
// Cada versículo leva uma marca <mark name="N"/> para o app saber o tempo exato de cada um.
// (o Google não cobra pelas marcas; a pausa entre versículos vem da própria pontuação)
export function buildChunks(intro, verses) {
  const out = [];
  let cur = intro ? esc(intro) + '<break time="600ms"/>' : "";
  const push = () => { if (cur) out.push("<speak>" + cur + "</speak>"); cur = ""; };
  verses.forEach((t, v) => {
    let piece = `<mark name="${v}"/>` + esc(t) + " ";
    if (bytes(piece) > MAX_BYTES - 20) {
      // versículo enorme: corta em frases, só a primeira leva a marca
      const parts = t.match(/[^.;:!?]+[.;:!?]*\s*/g) || [t];
      let first = true;
      for (const p of parts) {
        const s = (first ? `<mark name="${v}"/>` : "") + esc(p);
        if (bytes(cur + s) > MAX_BYTES - 20) push();
        cur += s; first = false;
      }
      cur += " ";
      return;
    }
    if (bytes(cur + piece) > MAX_BYTES - 20) push();
    cur += piece;
  });
  push();
  return out;
}

// Modo narrador: voz mais grave e mais pausada (estilo locutor de Bíblia)
const STYLES = { normal: { pitch: 0, speakingRate: 1.0 }, narrador: { pitch: -4, speakingRate: 0.86 } };
async function synth(ssml, voice, style = "normal") {
  const st = STYLES[style] || STYLES.normal;
  const r = await fetch("https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=" + encodeURIComponent(KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { ssml },
      voice: { languageCode: "pt-BR", name: voice },
      audioConfig: { audioEncoding: "MP3", speakingRate: st.speakingRate, pitch: st.pitch },
      enableTimePointing: ["SSML_MARK"],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Google TTS " + r.status + ": " + (j.error && j.error.message || "erro"));
  return {
    audio: Buffer.from(j.audioContent, "base64"),
    marks: (j.timepoints || []).map(t => [Number(t.markName), Math.round(t.timeSeconds * 1000) / 1000]),
  };
}

async function inBatches(items, n, fn) {
  const res = new Array(items.length);
  for (let i = 0; i < items.length; i += n) {
    const part = await Promise.all(items.slice(i, i + n).map((x, k) => fn(x, i + k)));
    part.forEach((r, k) => (res[i + k] = r));
  }
  return res;
}

const json = (obj, status = 200, cache = "public, max-age=86400") =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": cache } });
const mp3 = buf => new Response(buf, {
  headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable" },
});

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore("biblia-voz");
  try {
    // Lista de vozes para escolher no app
    if (url.searchParams.has("voices")) {
      if (!KEY) return json({ error: "sem_chave" }, 503, "no-store");
      return json({ default: VOICE, voices: await voiceList() }, 200, "public, max-age=3600");
    }
    const voice = KEY ? await pickVoice(url.searchParams.get("voice")) : VOICE;
    const style = url.searchParams.get("style") === "narrador" ? "narrador" : "normal";
    const vkey = style === "normal" ? voice : `${voice}~${style}`;

    // Amostra para o botão "Ouvir" na escolha de voz
    if (url.searchParams.has("sample")) {
      const k = `${vkey}/sample.mp3`;
      let buf = await store.get(k, { type: "arrayBuffer" });
      if (!buf) {
        if (!KEY) return json({ error: "sem_chave" }, 503, "no-store");
        const r = await synth("<speak>" + esc(SAMPLE) + "</speak>", voice, style);
        await store.set(k, r.audio);
        buf = r.audio;
      }
      return mp3(buf);
    }

    const id = (url.searchParams.get("b") || "").toUpperCase();
    const c = parseInt(url.searchParams.get("c"), 10);
    const p = url.searchParams.get("p");
    const B = await bible(url.origin);
    const book = B.find(x => x.id === id);
    if (!book || !(c >= 1 && c <= book.c.length)) return json({ error: "capitulo_invalido" }, 400, "no-store");
    const base = `${vkey}/${id}/${c}`;

    // Um pedaço de áudio
    if (p != null) {
      const buf = await store.get(`${base}/${parseInt(p, 10)}.mp3`, { type: "arrayBuffer" });
      if (!buf) return json({ error: "nao_encontrado" }, 404, "no-store");
      return mp3(buf);
    }

    // Índice do capítulo (gera tudo na primeira vez)
    let meta = await store.get(`${base}/meta.json`, { type: "json" });
    if (!meta) {
      if (!KEY) return json({ error: "sem_chave" }, 503, "no-store");
      const intro = (id === "PSA" ? "Salmo " : book.n + ", capítulo ") + c + ".";
      const chunks = buildChunks(intro, book.c[c - 1]);
      const done = await inBatches(chunks, 8, s => synth(s, voice, style));
      await Promise.all(done.map((d, i) => store.set(`${base}/${i}.mp3`, d.audio)));
      meta = { voice, style, parts: done.map(d => ({ marks: d.marks })) };
      await store.setJSON(`${base}/meta.json`, meta);
    }
    return json(meta);
  } catch (e) {
    return json({ error: "falha", detail: String(e.message || e) }, 500, "no-store");
  }
};

export const config = { path: "/api/tts" };
