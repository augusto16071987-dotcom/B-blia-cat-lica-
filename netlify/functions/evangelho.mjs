// Evangelho do dia segundo o calendário litúrgico (fonte: API pública Liturgia Diária, github.com/Dancrf/liturgia-diaria).
// Só usamos a REFERÊNCIA e o nome da celebração; o texto mostrado no app é o da tradução do Pe. Matos Soares.
import { getStore } from "@netlify/blobs";

const API = "https://liturgia.up.railway.app/v2/";
const json = (obj, status = 200, cache = "public, max-age=1800") =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": cache } });

async function fetchT(url, ms = 8000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal, headers: { "User-Agent": "BibliaCatolicaApp/1.0" } }); }
  finally { clearTimeout(t); }
}

function pick(d) {
  const L = d.leituras || {};
  const ev = (L.evangelho || d.evangelho || [])[0] || null;
  return {
    liturgia: d.liturgia || "",
    cor: d.cor || "",
    ref: ev ? String(ev.referencia || "").trim() : "",
    titulo: ev ? String(ev.titulo || "").trim() : "",
  };
}

async function oneDay(store, iso) {
  const k = "ev:" + iso;
  const hit = await store.get(k, { type: "json" }).catch(() => null);
  if (hit && hit.ref) return { date: iso, ...hit };
  const [y, m, d] = iso.split("-");
  const r = await fetchT(`${API}?dia=${+d}&mes=${+m}&ano=${y}`);
  if (!r.ok) throw new Error("liturgia " + r.status);
  const j = await r.json();
  const out = pick(Array.isArray(j) ? j[0] : j);
  if (out.ref) await store.setJSON(k, out).catch(() => {});
  return { date: iso, ...out };
}

export default async (req) => {
  const u = new URL(req.url);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("d") || "") ? u.searchParams.get("d") : new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const n = Math.min(7, Math.max(1, parseInt(u.searchParams.get("n"), 10) || 1));
  const store = getStore("evangelho");
  const dates = [];
  for (let i = 0; i < n; i++) { const t = new Date(start + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + i); dates.push(t.toISOString().slice(0, 10)); }
  const res = await Promise.allSettled(dates.map(d => oneDay(store, d)));
  const days = res.map((r, i) => r.status === "fulfilled" ? r.value : { date: dates[i], error: String(r.reason && r.reason.message || r.reason) });
  if (!days[0] || !days[0].ref) return json({ error: "sem_liturgia", days }, 502, "no-store");
  return json({ days });
};

export const config = { path: "/api/evangelho" };
