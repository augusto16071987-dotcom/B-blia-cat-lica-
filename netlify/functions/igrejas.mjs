// Busca igrejas católicas perto de um ponto (ou de uma cidade): Google primeiro, OpenStreetMap de reserva.
// Fica no servidor para evitar bloqueios do navegador e para guardar o resultado por alguns dias.
import { getStore } from "@netlify/blobs";

const UA = "BibliaCatolicaApp/1.0 (bibliacatolicaromana.netlify.app)";
// Google (Places API New) — a mesma base do Google Maps. Usa a mesma chave da voz.
const GKEY = process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_TTS_KEY;
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const CATHOLIC_NAME = /^(par[oó]quia|matriz|catedral|santu[aá]rio|bas[ií]lica|capela|comunidade (cat[oó]lica|de )?(s[aã]o|santa|santo|nossa)|igreja (matriz|cat[oó]lica)|igreja (de |da |do )?(nossa senhora|n\.? ?sra|s[aã]o|santa|santo|sagrad|divino|bom jesus|cristo rei|imaculad))/i;
const NOT_CATHOLIC = /(assembl|batista|presbit|universal|adventista|metodista|luterana|evang|deus [ée] amor|quadrangular|congrega[cç][aã]o crist|mundial|pentecost|testemunha|mórmon|jesus cristo dos santos)/i;

const json = (obj, status = 200, cache = "public, max-age=3600") =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": cache } });

async function fetchT(url, opts = {}, ms = 7000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

const UF = { AC:"Acre", AL:"Alagoas", AP:"Amapá", AM:"Amazonas", BA:"Bahia", CE:"Ceará", DF:"Distrito Federal",
  ES:"Espírito Santo", GO:"Goiás", MA:"Maranhão", MT:"Mato Grosso", MS:"Mato Grosso do Sul", MG:"Minas Gerais",
  PA:"Pará", PB:"Paraíba", PR:"Paraná", PE:"Pernambuco", PI:"Piauí", RJ:"Rio de Janeiro", RN:"Rio Grande do Norte",
  RS:"Rio Grande do Sul", RO:"Rondônia", RR:"Roraima", SC:"Santa Catarina", SP:"São Paulo", SE:"Sergipe", TO:"Tocantins" };

// "Castelo ES", "Castelo - ES", "Castelo, Espírito Santo" -> { city, state }
function splitCity(q) {
  const m = q.trim().match(/^(.*?)[\s,\-\/]+([A-Za-z]{2})$/);
  if (m && UF[m[2].toUpperCase()]) return { city: m[1].trim(), state: UF[m[2].toUpperCase()] };
  const parts = q.split(/\s*[,\-\/]\s*/);
  if (parts.length > 1) return { city: parts[0], state: parts.slice(1).join(" ") };
  return { city: q.trim(), state: "" };
}

async function nominatim(params) {
  const r = await fetchT("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&accept-language=pt-BR&" + params, {}, 5000);
  if (!r.ok) throw new Error("nominatim " + r.status);
  const j = await r.json();
  return j.length ? { lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name.split(",")[0] } : null;
}
async function photon(q) {
  const r = await fetchT("https://photon.komoot.io/api/?limit=5&q=" + encodeURIComponent(q), {}, 5000);
  if (!r.ok) throw new Error("photon " + r.status);
  const j = await r.json();
  const f = (j.features || []).find(f => f.properties && f.properties.countrycode === "BR");
  return f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.name } : null;
}

async function geocode(q) {
  const { city, state } = splitCity(q);
  const tries = [
    () => state ? nominatim("city=" + encodeURIComponent(city) + "&state=" + encodeURIComponent(state)) : null,
    () => nominatim("q=" + encodeURIComponent(state ? city + ", " + state : city)),
    () => photon(state ? city + ", " + state + ", Brasil" : city + ", Brasil"),
  ];
  for (const t of tries) {
    try { const g = await t(); if (g) return g; } catch (e) {}
  }
  return null;
}

async function googleSearch(textQuery, lat, lon, radius) {
  const body = { textQuery, languageCode: "pt-BR", regionCode: "BR", pageSize: 20 };
  if (lat != null) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(50000, radius) } };
  const r = await fetchT("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location" },
    body: JSON.stringify(body),
  }, 7000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("google " + r.status + ": " + (j.error && j.error.message || ""));
  return (j.places || []).filter(p => p.location).map(p => ({
    name: (p.displayName && p.displayName.text) || "Igreja Católica",
    lat: p.location.latitude, lon: p.location.longitude,
    addr: (p.formattedAddress || p.shortFormattedAddress || "").replace(/, Brasil$/, "").replace(/, \d{5}-\d{3}/, ""),
    mass: "",
  })).filter(x => !NOT_CATHOLIC.test(x.name));
}

function addrOf(t) {
  const rua = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(", ");
  return [rua, t["addr:suburb"] || t["addr:neighbourhood"], t["addr:city"]].filter(Boolean).join(" · ");
}
function dist(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function churches(lat, lon, radius) {
  const q = `[out:json][timeout:8];nwr["amenity"="place_of_worship"]["religion"="christian"](around:${radius},${lat},${lon});out center tags;`;
  // pergunta para todos os servidores de mapa ao mesmo tempo e usa o primeiro que responder
  const ask = async (url) => {
    const r = await fetchT(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } }, 7500);
    if (!r.ok) throw new Error(url + " " + r.status);
    const j = await r.json();
    if (j.remark && /error|timed out/i.test(j.remark) && !(j.elements || []).length) throw new Error(j.remark);
    return j;
  };
  const j = await Promise.any(OVERPASS.map(ask));
  const seen = new Set();
  return (j.elements || []).map(e => {
    const t = e.tags || {}, la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon, name = t.name || "";
    const den = (t.denomination || "").toLowerCase();
    const catholic = den.includes("catholic") || (!den && name && CATHOLIC_NAME.test(name) && !NOT_CATHOLIC.test(name));
    if (!catholic || la == null) return null;
    return { name: name || "Igreja Católica", lat: la, lon: lo, addr: addrOf(t), mass: t.service_times || "", d: dist(lat, lon, la, lo) };
  }).filter(x => x && !seen.has(x.name + Math.round(x.lat * 1e3)) && seen.add(x.name + Math.round(x.lat * 1e3)))
    .sort((a, b) => a.d - b.d).slice(0, 150);
}

export default async (req) => {
  const u = new URL(req.url);
  const radius = Math.min(30000, Math.max(1000, parseInt(u.searchParams.get("r"), 10) || 10000));
  let googleErrMsg = null;
  try {
    let lat = parseFloat(u.searchParams.get("lat")), lon = parseFloat(u.searchParams.get("lon")), label = "você";
    const city = (u.searchParams.get("q") || "").trim();

    // 1) Google
    if (GKEY) {
      try {
        const store = getStore("igrejas");
        const gkey = "g:" + (city ? "q:" + city.toLowerCase() : `${lat.toFixed(2)},${lon.toFixed(2)}`) + ":" + radius;
        let hit = await store.get(gkey, { type: "json" }).catch(() => null);
        if (!hit || Date.now() - hit.at > 7 * 864e5) {
          let list, cLat = lat, cLon = lon, cLabel = label;
          if (city) {
            list = await googleSearch("igreja católica em " + city, null, null, radius);
            // centro = mediana das igrejas encontradas (rápido, sem depender de outro serviço)
            if (list.length) {
              const med = arr => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];
              cLat = med(list.map(x => x.lat)); cLon = med(list.map(x => x.lon)); cLabel = splitCity(city).city;
            }
          } else {
            list = await googleSearch("igreja católica", lat, lon, radius);
          }
          hit = { at: Date.now(), lat: cLat, lon: cLon, label: cLabel, list };
          if (list.length) await store.setJSON(gkey, hit).catch(() => {});
        }
        if (hit.list.length) {
          const cl = hit.lat ?? lat, co = hit.lon ?? lon;
          const out = hit.list.map(x => ({ ...x, d: Number.isFinite(cl) ? dist(cl, co, x.lat, x.lon) : 0 }))
            .filter(x => !Number.isFinite(cl) || x.d <= radius / 1000 * 1.6).sort((a, b) => a.d - b.d);
          if (out.length) return json({ lat: cl, lon: co, label: city ? (hit.label || city) : label, source: "google", list: out });
        }
      } catch (e) { googleErrMsg = String(e.message || e); }
    }

    // 2) Reserva: OpenStreetMap
    if (city) {
      const g = await geocode(city);
      if (!g) return json({ error: "cidade_nao_encontrada", google: googleErrMsg }, 404, "no-store");
      ({ lat, lon, label } = g);
    }
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return json({ error: "local_invalido" }, 400, "no-store");

    // guarda por 7 dias, por região (~1 km) e raio
    const store = getStore("igrejas");
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${radius}`;
    const hit = await store.get(key, { type: "json" }).catch(() => null);
    if (hit && Date.now() - hit.at < 7 * 864e5) return json({ lat, lon, label, list: hit.list.map(x => ({ ...x, d: dist(lat, lon, x.lat, x.lon) })).sort((a, b) => a.d - b.d) });
    const list = await churches(lat, lon, radius);
    await store.setJSON(key, { at: Date.now(), list }).catch(() => {});
    return json({ lat, lon, label, list });
  } catch (e) {
    return json({ error: "falha", detail: String(e.message || e), google: googleErrMsg }, 502, "no-store");
  }
};

export const config = { path: "/api/igrejas" };
