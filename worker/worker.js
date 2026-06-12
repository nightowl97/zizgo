/* ZizGo - consolidated Cloudflare Worker proxy.
   One worker for all lines: GET https://<worker>/?line=l02
   Strict allowlist; unknown keys are rejected (no open proxy). */

const LINES = {
  l01: 47,
  l02: 48,
  l03: 53,
};
const RESEAUX_ID = 8;
const API_HOST = "HOSTNAME"; // <- your transit API hostname (plain HTTP)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const line = new URL(request.url).searchParams.get("line");
    const apiId = LINES[line];
    if (!apiId) {
      return new Response(JSON.stringify({ error: "unknown line" }), {
        status: 400, headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    try {
      const resp = await fetch(`http://${API_HOST}/api/line_horaires/${apiId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reseaux_id: RESEAUX_ID }),
      });
      if (!resp.ok) throw new Error(`API returned ${resp.status}`);
      const data = await resp.json();

      const buses = [];
      for (const key of ["buses_aller", "buses_retour"]) {
        for (const b of (data[key] || [])) {
          const [lat, lng] = (b.localisation || "").split(",").map(Number);
          if (!isNaN(lat) && !isNaN(lng)) {
            buses.push({ bus: b.bus, sens: b.sens, lat, lng, src_updated_at: b.updated_at });
          }
        }
      }

      return new Response(
        JSON.stringify({ fetched_at: new Date().toISOString(), line, buses }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502, headers: { "Content-Type": "application/json", ...CORS },
      });
    }
  },
};
