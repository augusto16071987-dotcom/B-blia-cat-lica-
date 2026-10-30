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


// Orações do terço (as mesmas do app). Só estas chaves podem ser lidas, para evitar uso indevido.
const OR = {
 sinal:["Sinal da Cruz","Pelo sinal da Santa Cruz, livrai-nos, Deus, nosso Senhor, dos nossos inimigos.\nEm nome do Pai, e do Filho, e do Espírito Santo. Amém."],
 creio:["Creio","Creio em Deus Pai todo-poderoso, criador do céu e da terra; e em Jesus Cristo, seu único Filho, nosso Senhor; que foi concebido pelo poder do Espírito Santo; nasceu da Virgem Maria; padeceu sob Pôncio Pilatos, foi crucificado, morto e sepultado; desceu à mansão dos mortos; ressuscitou ao terceiro dia; subiu aos céus; está sentado à direita de Deus Pai todo-poderoso, donde há de vir a julgar os vivos e os mortos.\nCreio no Espírito Santo, na santa Igreja Católica, na comunhão dos santos, na remissão dos pecados, na ressurreição da carne, na vida eterna. Amém."],
 pai:["Pai Nosso","Pai nosso que estais nos céus, santificado seja o vosso nome; venha a nós o vosso reino; seja feita a vossa vontade, assim na terra como no céu.\nO pão nosso de cada dia nos dai hoje; perdoai-nos as nossas ofensas, assim como nós perdoamos a quem nos tem ofendido; e não nos deixeis cair em tentação, mas livrai-nos do mal. Amém."],
 ave:["Ave Maria","Ave Maria, cheia de graça, o Senhor é convosco; bendita sois vós entre as mulheres, e bendito é o fruto do vosso ventre, Jesus.\nSanta Maria, Mãe de Deus, rogai por nós, pecadores, agora e na hora de nossa morte. Amém."],
 gloria:["Glória ao Pai","Glória ao Pai, ao Filho e ao Espírito Santo.\nComo era no princípio, agora e sempre. Amém."],
 jesus:["Ó meu Jesus","Ó meu Jesus, perdoai-nos, livrai-nos do fogo do inferno; levai as almas todas para o céu e socorrei principalmente as que mais precisarem."],
 salve:["Salve Rainha","Salve, Rainha, Mãe de misericórdia, vida, doçura e esperança nossa, salve! A vós bradamos, os degredados filhos de Eva; a vós suspiramos, gemendo e chorando neste vale de lágrimas. Eia, pois, advogada nossa, esses vossos olhos misericordiosos a nós volvei; e, depois deste desterro, mostrai-nos Jesus, bendito fruto do vosso ventre, ó clemente, ó piedosa, ó doce sempre Virgem Maria.\nV. Rogai por nós, santa Mãe de Deus.\nR. Para que sejamos dignos das promessas de Cristo. Amém."]};
const MYS = {
 gozosos:{n:"Gozosos",dias:"segunda e sábado",m:[["A Anunciação do Anjo a Nossa Senhora","LUK",1,26,38,38],["A Visitação de Nossa Senhora a Santa Isabel","LUK",1,39,56,42],["O Nascimento de Jesus em Belém","LUK",2,1,20,7],["A Apresentação do Menino Jesus no Templo","LUK",2,22,38,30],["O Encontro do Menino Jesus no Templo","LUK",2,41,52,49]]},
 luminosos:{n:"Luminosos",dias:"quinta-feira",m:[["O Batismo de Jesus no rio Jordão","MAT",3,13,17,17],["A autorrevelação de Jesus nas Bodas de Caná","JHN",2,1,12,5],["O Anúncio do Reino de Deus e o convite à conversão","MRK",1,14,15,15],["A Transfiguração de Jesus","LUK",9,28,36,35],["A Instituição da Eucaristia","LUK",22,14,20,19]]},
 dolorosos:{n:"Dolorosos",dias:"terça e sexta",m:[["A Agonia de Jesus no Horto das Oliveiras","LUK",22,39,46,42],["A Flagelação de Jesus","JHN",19,1,1,1],["A Coroação de espinhos","MAT",27,27,31,29],["Jesus carrega a Cruz até o Calvário","JHN",19,16,17,17],["A Crucifixão e Morte de Jesus","LUK",23,33,46,46]]},
 gloriosos:{n:"Gloriosos",dias:"quarta e domingo",m:[["A Ressurreição de Jesus","MAT",28,1,10,6],["A Ascensão de Jesus ao Céu","ACT",1,6,11,9],["A Vinda do Espírito Santo sobre Maria e os Apóstolos","ACT",2,1,4,4],["A Assunção de Nossa Senhora ao Céu","LUK",1,46,49,48],["A Coroação de Nossa Senhora como Rainha do céu e da terra","REV",12,1,1,1]]}};
const ORDW = ["Primeiro", "Segundo", "Terceiro", "Quarto", "Quinto"];
function prayerText(key) {
  let m = key.match(/^p-(\w+)$/);
  if (m && OR[m[1]]) return OR[m[1]][1].replace(/^V\. |\nV\. |\nR\. /g, " ").replace(/\n/g, " ");
  m = key.match(/^m-(\w+)-([1-5])$/);
  if (m && MYS[m[1]]) { const set = MYS[m[1]], i = +m[2]; return `${ORDW[i - 1]} Mistério ${set.n.replace(/s$/, "")}. ${set.m[i - 1][0]}.`; }
  return null;
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

    // Orações do terço
    const pk = url.searchParams.get("prayer");
    if (pk) {
      const txt = prayerText(pk);
      if (!txt) return json({ error: "oracao_invalida" }, 400, "no-store");
      const k = `${vkey}/oracao/${pk}.mp3`;
      let buf = await store.get(k, { type: "arrayBuffer" });
      if (!buf) {
        if (!KEY) return json({ error: "sem_chave" }, 503, "no-store");
        const r = await synth("<speak>" + esc(txt) + "</speak>", voice, style);
        await store.set(k, r.audio);
        buf = r.audio;
      }
      return mp3(buf);
    }

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
