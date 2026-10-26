// Busca igrejas católicas perto de um ponto (ou de uma cidade) no OpenStreetMap.
// Fica no servidor para evitar bloqueios do navegador e para guardar o resultado por alguns dias.
import { getStore } from "@netlify/blobs";

const UA = "BibliaCatolicaApp/1.0 (bibliacatolicaromana.netlify.app)";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const CATHOLIC_NAME = /^(par[oó]quia|matriz|catedral|santu[aá]rio|bas[ií]lica|capela|comunidade|igreja (matriz|de )?(nossa senhora|n\.? ?sra|s[aã]o|santa|santo|sagrad|divino|bom jesus|cristo rei|imaculad))/i;
const NOT_CATHOLIC = /(assembl|batista|presbit|universal|adventista|metodista|luterana|evang|deus [ée] amor|quadrangular|congrega[cç][aã]o crist|mundial|pentecost|testemunha|mórmon|jesus cristo dos santos)/i;

const json = (obj, status = 200, cache = "public, max-age=3600") =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": cache } });

async function fetchT(url, opts = {}, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

async function geocode(q) {
  const r = await fetchT("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&accept-language=pt-BR&q=" + encodeURIComponent(q));
  if (!r.ok) throw new Error("geocode " + r.status);
  const j = await r.json();
  if (!j.length) return null;
  return { lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name.split(",")[0] };
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
  const q = `[out:json][timeout:25];nwr["amenity"="place_of_worship"]["religion"="christian"](around:${radius},${lat},${lon});out center tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetchT(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!r.ok) { lastErr = new Error(url + " " + r.status); continue; }
      const j = await r.json();
      const seen = new Set();
      return (j.elements || []).map(e => {
        const t = e.tags || {}, la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon, name = t.name || "";
        const den = (t.denomination || "").toLowerCase();
        const catholic = den.includes("catholic") || (!den && name && CATHOLIC_NAME.test(name) && !NOT_CATHOLIC.test(name));
        if (!catholic || la == null) return null;
        return { name: name || "Igreja Católica", lat: la, lon: lo, addr: addrOf(t), mass: t.service_times || "", d: dist(lat, lon, la, lo) };
      }).filter(x => x && !seen.has(x.name + Math.round(x.lat * 1e3)) && seen.add(x.name + Math.round(x.lat * 1e3)))
        .sort((a, b) => a.d - b.d).slice(0, 150);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("overpass");
}

export default async (req) => {
  const u = new URL(req.url);
  const radius = Math.min(30000, Math.max(1000, parseInt(u.searchParams.get("r"), 10) || 10000));
  try {
    let lat = parseFloat(u.searchParams.get("lat")), lon = parseFloat(u.searchParams.get("lon")), label = "você";
    const city = (u.searchParams.get("q") || "").trim();
    if (city) {
      const g = await geocode(city);
      if (!g) return json({ error: "cidade_nao_encontrada" }, 404);
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
    return json({ error: "falha", detail: String(e.message || e) }, 502, "no-store");
  }
};

export const config = { path: "/api/igrejas" };
