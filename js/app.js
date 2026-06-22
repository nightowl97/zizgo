/* ZizGo - production app logic.
   Ports the proven map.html engine (snap-to-line, selection, polling)
   into the Dunes app shell. No frameworks. */

const REFRESH_MS = 10000;
const LINE_IDS = ["l01", "l02", "l03"];

// ── geometry (unchanged from map.html) ─────────────────────────────────────
function extractPoints(gj) {
  const pts = [];
  const pushLine = coords => { for (const [lng, lat] of coords) pts.push({ lat, lng }); };
  const walk = g => {
    if (!g) return;
    if (g.type === "LineString")        pushLine(g.coordinates);
    if (g.type === "MultiLineString")   g.coordinates.forEach(pushLine);
    if (g.type === "Feature")           walk(g.geometry);
    if (g.type === "FeatureCollection") g.features.forEach(walk);
  };
  walk(gj);
  return pts;
}

function snapToLine(pts, lat, lng) {
  if (!pts || pts.length < 2) return { lat, lng, segIdx: 0 };
  let best = { lat, lng, segIdx: 0 };
  let minD2 = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i], B = pts[i + 1];
    const abLat = B.lat - A.lat, abLng = B.lng - A.lng;
    const apLat = lat - A.lat,   apLng = lng - A.lng;
    const ab2 = abLat * abLat + abLng * abLng;
    if (ab2 === 0) continue;
    const t = Math.max(0, Math.min(1, (apLat * abLat + apLng * abLng) / ab2));
    const pLat = A.lat + t * abLat, pLng = A.lng + t * abLng;
    const d2 = (lat - pLat) ** 2 + (lng - pLng) ** 2;
    if (d2 < minD2) { minD2 = d2; best = { lat: pLat, lng: pLng, segIdx: i }; }
  }
  return best;
}

// ── time helpers ────────────────────────────────────────────────────────────
function gpsTimeMs(utcStr) {
  // API timestamps are UTC, e.g. "2026-06-11 14:03:22"
  if (!utcStr) return null;
  const t = Date.parse(utcStr.replace(" ", "T") + (utcStr.endsWith("Z") ? "" : "Z"));
  return isNaN(t) ? null : t;
}
function gpsAge(utcStr) {
  const t = gpsTimeMs(utcStr);
  if (t == null) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}
function ageLabel(s) {
  if (s == null) return "-";
  if (s < 60) return `il y a ${s} s`;
  return `il y a ${Math.round(s / 60)} min`;
}
function endpointsOf(LINE) {
  const m = LINE.sensDirMap || {};
  const a = (m["0"] || "").replace(/^→\s*/, "");
  const b = (m["1"] || "").replace(/^→\s*/, "");
  if (a && b) return `${a} ↔ ${b}`;
  const s = LINE.stations || [];
  return s.length ? `${s[0]} ↔ ${s[s.length - 1]}` : LINE.name;
}

// ── boot ────────────────────────────────────────────────────────────────────
(async () => {
  const $ = sel => document.querySelector(sel);

  const LINES = (await Promise.all(
    LINE_IDS.map(id => fetch(`lines/${id}.json`).then(r => r.json()).catch(() => null))
  )).filter(Boolean);

  const stationsData = await fetch("stations.json").then(r => r.json()).catch(() => []);
  const stationPos = new Map(stationsData.map(s => [s.name, s]));

  // desktop splash: line preview chips
  $("#splash-lines").innerHTML = LINES.map(L_ => `
    <span class="sl-chip">
      <span class="sl-badge" style="background:${L_.color}">${L_.name}</span>
      <span class="sl-name">${endpointsOf(L_)}</span>
    </span>`).join("");

  // ── map ──
  const map = L.map("map", { zoomControl: false, attributionControl: false });
  L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);

  // basemap themes: light = warm voyager, dark = the original dark matter map
  const BASEMAPS = {
    light: { base: "voyager_nolabels", labels: "voyager_only_labels", casing: "#fbf3e6" },
    dark:  { base: "dark_nolabels",    labels: "dark_only_labels",    casing: "#11161c" },
  };
  const tileUrl = style => `https://{s}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png`;
  let CASING = BASEMAPS.light.casing;
  let baseTiles = null, labelTiles = null, boostTiles = null;
  let mapTheme = localStorage.getItem("zizgo-theme") === "light" ? "light" : "dark";

  // voyager is very low-contrast at town scale: a second copy of the same tiles,
  // multiply-blended over the first (see .leaflet-boost-pane), deepens roads/blocks
  map.createPane("boost").style.zIndex = 250; // above base tiles, below routes

  // blurred pane for route-highlight glow (blur lives in CSS; content only
  // changes on selection so the blurred raster is cached, not re-done per frame)
  map.createPane("glow").style.zIndex = 390;  // just below overlayPane (400)
  const glowRenderer = L.svg({ pane: "glow", padding: 0.5 });

  function applyTheme(theme) {
    const t = BASEMAPS[theme] ?? BASEMAPS.light;
    CASING = t.casing;
    document.body.classList.toggle("dark-map", theme === "dark");
    // crossfade: keep the old tiles underneath until the new base has loaded
    const oldLayers = [baseTiles, labelTiles, boostTiles].filter(Boolean);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      oldLayers.forEach(l => map.removeLayer(l));
    };
    baseTiles = L.tileLayer(tileUrl(t.base), {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    }).addTo(map);
    // labels only when zoomed in: at overview zooms the big city-name label
    // is redundant (it's baked into the raster tiles, so it can't be removed selectively)
    labelTiles = L.tileLayer(tileUrl(t.labels), { maxZoom: 19, minZoom: 15, pane: "shadowPane", opacity: 0.75 }).addTo(map);
    boostTiles = theme === "light"
      ? L.tileLayer(tileUrl(t.base), { maxZoom: 19, pane: "boost" }).addTo(map)
      : null;
    baseTiles.once("load", cleanup);
    setTimeout(cleanup, 2500); // fallback if tiles never finish (offline)
    // match the PWA/browser chrome (status bar) to the active theme
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#141009" : "#e6dac2";
    localStorage.setItem("zizgo-theme", theme);
  }
  applyTheme(mapTheme);

  $("#zoom-in").addEventListener("click", () => map.zoomIn());
  $("#zoom-out").addEventListener("click", () => map.zoomOut());

  $("#theme-btn").addEventListener("click", () => {
    mapTheme = mapTheme === "dark" ? "light" : "dark";
    applyTheme(mapTheme);
    // route casings + any active highlight were drawn for the old basemap
    for (const id in routeLayers)
      for (const dir in routeLayers[id]) {
        const [shadow] = routeLayers[id][dir] ?? [];
        if (shadow) shadow.setStyle({ color: CASING });
      }
    if (activeSelection) {
      const m = busMarkers.get(activeSelection.busKey);
      if (m) selectLine(activeSelection.lineId, m._busDir, m._busPosCur ?? m._busPos);
    } else if (selectedLineId) {
      selectLine(selectedLineId, null);
    }
  });

  let mePin = null;
  $("#locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (!mePin) {
        mePin = L.marker(ll, {
          icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
          zIndexOffset: 900,
        }).addTo(map);
      } else mePin.setLatLng(ll);
      map.setView(ll, Math.max(map.getZoom(), 15), { animate: true });
    });
  });

  const routeStyle = (weight, opacity, color) =>
    ({ color, weight, opacity, lineCap: "round", lineJoin: "round" });

  // ── routes, casing in cream for the light map ──
  const routeLayers = {};
  const routePts = {};
  const busMarkers = new Map();
  let highlightLayers = [];
  let splitRef = null;          // live refs to the past/future halves of a bus highlight
  let activeSelection = null;   // { busKey, lineId }
  let selectedLineId = null;    // chip selection

  const ptsToLatLng = pts => pts.map(p => [p.lat, p.lng]);

  // faint glow under a highlighted route: one stroke in the blurred glow pane
  function addGlow(pts, color) {
    if (!pts || pts.length < 2) return;
    highlightLayers.push(
      L.polyline(ptsToLatLng(pts), {
        // wider than the 12px casing so the halo stays bright past its edge (no dark ring)
        ...routeStyle(24, 0.05, color),
        interactive: false, pane: "glow", renderer: glowRenderer,
      }).addTo(map)
    );
  }

  function selectLine(lineId, dir, busPos) {
    highlightLayers.forEach(l => map.removeLayer(l));
    highlightLayers = [];
    splitRef = null;

    for (const LINE of LINES) {
      const dirs = routeLayers[LINE.id] ?? {};
      if (LINE.id === lineId) {
        if (dir && busPos != null) {
          for (const d of ["aller", "retour"]) {
            const [s, r] = dirs[d] ?? [];
            if (s) s.setStyle({ opacity: 0 });
            if (r) r.setStyle({ opacity: 0 });
          }
          const pts = routePts[LINE.id]?.[dir];
          if (pts?.length >= 2) {
            addGlow(pts, LINE.color);
            const idx = Math.max(0, Math.min(busPos.segIdx, pts.length - 2));
            // split at the bus's projected point, not the nearest node: long straight
            // segments have nodes only at their ends, so a node split would paint
            // part of the bus's own segment with the wrong shade
            const past = ptsToLatLng([...pts.slice(0, idx + 1), busPos]);
            const future = ptsToLatLng([busPos, ...pts.slice(idx + 1)]);
            const pastLayers = [
              L.polyline(past, routeStyle(12, 0.35, CASING)).addTo(map),
              L.polyline(past, routeStyle(7, 0.3, LINE.color)).addTo(map),
            ];
            const futureLayers = [
              L.polyline(future, routeStyle(12, 0.8, CASING)).addTo(map),
              L.polyline(future, routeStyle(7, 0.95, LINE.color)).addTo(map),
            ];
            highlightLayers.push(...pastLayers, ...futureLayers);
            splitRef = { pts, pastLayers, futureLayers };
          }
          const opp = dir === "aller" ? "retour" : "aller";
          const oppPts = routePts[LINE.id]?.[opp];
          if (oppPts?.length >= 2) highlightLayers.push(
            L.polyline(ptsToLatLng(oppPts), routeStyle(12, 0.2, CASING)).addTo(map),
            L.polyline(ptsToLatLng(oppPts), routeStyle(7, 0.25, LINE.color)).addTo(map)
          );
        } else {
          addGlow(routePts[LINE.id]?.aller || routePts[LINE.id]?.retour, LINE.color);
          const [as_, ar] = dirs["aller"] ?? [];
          if (as_) { as_.setStyle({ opacity: 0.8 }); as_.bringToFront(); }
          if (ar)  { ar.setStyle({ opacity: 0.95 }); ar.bringToFront(); }
        }
      } else {
        const [as_, ar] = dirs["aller"] ?? [];
        if (as_) as_.setStyle({ opacity: 0.1 });
        if (ar)  ar.setStyle({ opacity: 0.22 });
        const [rs, rr] = dirs["retour"] ?? [];
        if (rs) rs.setStyle({ opacity: 0 });
        if (rr) rr.setStyle({ opacity: 0 });
        for (const [key, m] of busMarkers)
          if (key.startsWith(`${LINE.id}:`)) m.setOpacity(0.25);
      }
    }
    for (const [key, m] of busMarkers)
      if (key.startsWith(`${lineId}:`)) m.setOpacity(1);
  }

  // move the past/future boundary without rebuilding the highlight layers;
  // called every animation frame while the selected bus slides, so throttled
  let splitLastAt = 0;
  function updateSplit(pos, force) {
    if (!splitRef || pos?.segIdx == null) return;
    const now = performance.now();
    if (!force && now - splitLastAt < 120) return;
    splitLastAt = now;
    const { pts, pastLayers, futureLayers } = splitRef;
    const idx = Math.max(0, Math.min(pos.segIdx, pts.length - 2));
    const past = ptsToLatLng([...pts.slice(0, idx + 1), pos]);
    const future = ptsToLatLng([pos, ...pts.slice(idx + 1)]);
    pastLayers.forEach(l => l.setLatLngs(past));
    futureLayers.forEach(l => l.setLatLngs(future));
  }

  function resetSelection() {
    activeSelection = null;
    selectedLineId = null;
    hideCallout();
    highlightLayers.forEach(l => map.removeLayer(l));
    highlightLayers = [];
    splitRef = null;
    for (const [, m] of busMarkers) m.setOpacity(1);
    for (const LINE of LINES) {
      const dirs = routeLayers[LINE.id] ?? {};
      const [as_, ar] = dirs["aller"] ?? [];
      if (as_) as_.setStyle({ opacity: 0.8 });
      if (ar)  ar.setStyle({ opacity: 0.95 });
      const [rs, rr] = dirs["retour"] ?? [];
      if (rs) rs.setStyle({ opacity: 0 });
      if (rr) rr.setStyle({ opacity: 0 });
    }
    syncChips();
    syncSheetHead();
  }
  map.on("click", resetSelection);

  // select a whole line (no specific bus) and reflect it everywhere. fit=false
  // when the trigger is a tap on the route itself (don't yank the viewport).
  function chooseLine(LINE, fit = true) {
    activeSelection = null;
    hideCallout();
    selectedLineId = LINE.id;
    selectLine(LINE.id, null);
    if (fit) fitLine(LINE);
    syncChips();
    syncSheetHead();
  }

  // ── load routes + stops ──
  const stationLines = new Map();
  for (const LINE of LINES)
    for (const name of LINE.stations ?? []) {
      if (!stationLines.has(name)) stationLines.set(name, []);
      stationLines.get(name).push(LINE);
    }

  await Promise.all(LINES.map(async LINE => {
    routePts[LINE.id] = { aller: null, retour: null };
    routeLayers[LINE.id] = {};
    await Promise.all([["aller", LINE.allerUrl], ["retour", LINE.retourUrl]].map(async ([dir, url]) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return;
        const gj = await r.json();
        routePts[LINE.id][dir] = extractPoints(gj);
        const initOpacity = dir === "aller" ? 0.95 : 0;
        const initCasing  = dir === "aller" ? 0.8  : 0;
        const shadow = L.geoJSON(gj, { style: routeStyle(12, initCasing, CASING) }).addTo(map);
        const route  = L.geoJSON(gj, { style: routeStyle(7, initOpacity, LINE.color) }).addTo(map);
        route.on("click", e => {
          L.DomEvent.stopPropagation(e);
          chooseLine(LINE, false); // tapped the route itself: keep the viewport
        });
        routeLayers[LINE.id][dir] = [shadow, route];
      } catch {}
    }));
  }));

  // ── station progress along each direction (drives the rail's bus dots) ──
  // flat-earth distances are fine at city scale: only ratios are used
  const segDist = (a, b) => {
    const dx = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    return Math.hypot(dx, b.lat - a.lat);
  };
  const lineProg = {}; // lineId → dir → { st: per-station progress, progressOf }
  for (const LINE of LINES) {
    lineProg[LINE.id] = {};
    for (const dir of ["aller", "retour"]) {
      const pts = routePts[LINE.id]?.[dir];
      if (!pts || pts.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + segDist(pts[i - 1], pts[i]));
      const progressOf = snapped => cum[snapped.segIdx] + segDist(pts[snapped.segIdx], snapped);
      const st = (LINE.stations || []).map(name => {
        const p = stationPos.get(name);
        return p ? progressOf(snapToLine(pts, p.lat, p.lng)) : null;
      });
      lineProg[LINE.id][dir] = { st, progressOf, pts, cum };
    }
  }

  // inverse of progressOf: the point sitting at a given distance along the line
  function pointAtProgress(lp, prog) {
    const { pts, cum } = lp;
    const p = Math.max(0, Math.min(prog, cum[cum.length - 1]));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= p) lo = mid; else hi = mid;
    }
    const t = (p - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return {
      lat: pts[lo].lat + (pts[hi].lat - pts[lo].lat) * t,
      lng: pts[lo].lng + (pts[hi].lng - pts[lo].lng) * t,
      segIdx: lo,
    };
  }

  // where along the displayed station list a bus sits: rows i→j at fraction f
  function railPlacement(LINE, dir, pos) {
    const lp = lineProg[LINE.id]?.[dir];
    if (!lp || !pos) return null;
    const prog = lp.progressOf(pos);
    const known = [];
    lp.st.forEach((v, i) => { if (v != null) known.push(i); });
    if (known.length < 2) return null;
    for (let k = 0; k < known.length - 1; k++) {
      const a = lp.st[known[k]], b = lp.st[known[k + 1]];
      if (a === b) continue;
      const f = (prog - a) / (b - a); // sign-safe: works for list order running either way
      if (f >= 0 && f <= 1) return { i: known[k], j: known[k + 1], f };
    }
    // beyond the ends (terminus layover, GPS noise): pin to the nearer terminus
    const first = lp.st[known[0]], last = lp.st[known[known.length - 1]];
    const i = Math.abs(prog - first) <= Math.abs(prog - last) ? known[0] : known[known.length - 1];
    return { i, j: i, f: 0 };
  }

  const stopGroup = L.featureGroup().addTo(map);
  const stopMarkers = new Map();
  for (const [name, serving] of stationLines) {
    const pos = stationPos.get(name);
    if (!pos) continue;
    const terminusFor = serving.filter(LINE => {
      const s = LINE.stations;
      return s[0] === name || s[s.length - 1] === name;
    });
    const isTerminus = terminusFor.length > 0;
    const size = isTerminus ? 14 : 10;
    const color = (terminusFor[0] || serving[0]).color;
    const icon = L.divIcon({
      className: "",
      html: `<div class="stop-pin${isTerminus ? " terminus" : ""}" style="--lc:${color}"></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
    const marker = L.marker([pos.lat, pos.lng], { icon })
      .bindTooltip(name, { direction: "top", offset: [0, -8], opacity: 0.9 })
      .addTo(stopGroup);
    stopMarkers.set(name, marker);
  }
  // #app is still display:none here, so Leaflet can't size itself yet;
  // remember the network bounds and fit them again once the app is revealed.
  const homeBounds = stopGroup.getLayers().length > 0 ? stopGroup.getBounds().pad(0.08) : null;
  if (homeBounds) map.fitBounds(homeBounds);
  else map.setView([31.93, -4.43], 13);

  // ── bus callout (real data only: line, direction, bus, GPS age) ──
  // rendered twice: floating card on mobile, rail detail card on desktop
  const callout = $("#bus-callout");
  const railDetail = $("#rail-detail");
  // estimated ground speed, from the most recent inter-fix interval (see ingestFix).
  // "-" until a 2nd fix establishes it; resets after a direction reversal.
  function speedLabel(m) {
    if (!m || m._speedKmh == null) return "-";
    return `≈ ${Math.round(m._speedKmh)}`;
  }
  function showCallout(LINE, b, m) {
    const dirLabel = LINE.sensDirMap?.[String(b.sens)] ?? `sens ${b.sens}`;
    const age = gpsAge(b.src_updated_at);
    const html = `
      <div class="co-head">
        <span class="co-badge" style="background:${LINE.color}">${LINE.name}</span>
        <span class="co-title"><b>${dirLabel}</b><small>${endpointsOf(LINE)}</small></span>
        <button class="co-close" aria-label="Fermer">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
        </button>
      </div>
      <div class="co-stats">
        <span class="co-stat"><b style="color:${LINE.color}">Bus ${b.bus}</b><small>véhicule</small></span>
        <span class="co-div"></span>
        <span class="co-stat"><b data-bus-speed>${speedLabel(m)}</b><small>km/h</small></span>
        <span class="co-div"></span>
        <span class="co-stat"><b data-gps-age>${ageLabel(age)}</b><small>position GPS</small></span>
      </div>`;
    for (const el of [callout, railDetail]) {
      el.innerHTML = html;
      el.hidden = false;
      el.querySelector(".co-close").addEventListener("click", e => {
        e.stopPropagation(); resetSelection();
      });
    }
    railDetail.style.borderColor = LINE.color;
    calloutGpsRef = b.src_updated_at;
    calloutMarker = m;
  }
  function hideCallout() { callout.hidden = true; railDetail.hidden = true; calloutGpsRef = null; calloutMarker = null; }

  // tick the open bus card every second: GPS age counts up, speed tracks the
  // latest velocity estimate (which only changes on a fix, but keep them in sync)
  let calloutGpsRef = null;
  let calloutMarker = null;
  setInterval(() => {
    if (calloutGpsRef == null) return;
    const age = ageLabel(gpsAge(calloutGpsRef));
    const spd = speedLabel(calloutMarker);
    document.querySelectorAll("[data-gps-age]").forEach(el => { el.textContent = age; });
    document.querySelectorAll("[data-bus-speed]").forEach(el => { el.textContent = spd; });
  }, 1000);

  // ── live polling ──
  const sensDir = s => (s === 1 ? "retour" : "aller");
  const liveCounts = Object.fromEntries(LINES.map(L_ => [L_.id, 0]));
  let firstDataResolved;
  const firstData = new Promise(res => (firstDataResolved = res));

  function busIcon(color, colorRgb) {
    return L.divIcon({
      className: "",
      html: `<div class="bus-wrap">
               <div class="bus-ring" style="background:rgba(${colorRgb},.35)"></div>
               <div class="bus-ring" style="background:rgba(${colorRgb},.35)"></div>
               <div class="bus-core" style="background:${color};border:2.5px solid #fbf3e6;box-shadow:0 0 0 1px rgba(${colorRgb},.4),0 2px 10px rgba(60,42,20,.45)"></div>
             </div>`,
      iconSize: [56, 56], iconAnchor: [28, 28],
    });
  }

  // ── smooth marker movement: interpolation with a render delay ──
  // Extrapolating (predicting ahead at an estimated speed) overshoots whenever a
  // bus slows or stops: the decaying velocity keeps pushing the marker forward,
  // the next fix yanks it back, and it oscillates. Instead we render slightly in
  // the PAST — each marker replays the path between its last two real fixes. The
  // marker therefore lags the bus by ~one update and NEVER passes a position the
  // bus hasn't actually reached; a stopped bus sits perfectly still. People
  // expect a little lag in live tracking, so trailing reads as natural.
  const PREFERS_MOTION = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // how far in the past to render. ≈ one fix interval so we're always interpolating
  // between two fixes we already have. 0 = snap to each fix (reduced-motion).
  const INTERP_DELAY_MS = PREFERS_MOTION ? REFRESH_MS : 0;
  const SNAP_DEG = 0.02;       // lat+lng delta beyond which we hard-snap (reassigned vehicle / GPS gap)
  const DEG_TO_KM = 111;       // km per degree of latitude (≈ at Errachidia)

  // Leaflet rounds layer points to whole pixels, so slow motion stair-steps;
  // re-apply the icon transform with the unrounded projection for sub-pixel motion
  function setLatLngSubpixel(m, lat, lng) {
    m.setLatLng([lat, lng]); // keeps Leaflet's internal state (zoom redraws, events)
    if (m._icon)
      L.DomUtil.setPosition(m._icon, map.project([lat, lng])._subtract(map.getPixelOrigin()));
  }

  // fold a new GPS fix into a marker's sample buffer (last 3 fixes, oldest first)
  function ingestFix(m, lineId, dir, pos, gtMs) {
    const lp = lineProg[lineId]?.[dir];
    const from = m.getLatLng();
    const jump = Math.abs(pos.lat - from.lat) + Math.abs(pos.lng - from.lng) > SNAP_DEG;
    const rt = performance.now();
    // no route table, implausible jump, or direction reversal (progress is
    // per-direction, so its coordinate frame changed): drop history and hard-snap
    if (!lp || jump || m._busDir !== dir || !m._buf) {
      m._lp = lp || null;
      m._busDir = dir;
      m._speedKmh = null;
      if (lp) {
        const prog = lp.progressOf(pos);
        m._buf = [{ prog, rt }];
        m._dispProg = prog;
        m._busPosCur = pointAtProgress(lp, prog);
      } else {
        m._buf = null;
        m._busPosCur = pos;
      }
      setLatLngSubpixel(m, pos.lat, pos.lng);
      return;
    }
    const prog = lp.progressOf(pos);
    const last = m._buf[m._buf.length - 1];
    if (gtMs != null && last.gt === gtMs) return; // same beacon reading returned again
    // displayed speed: just the most recent interval, no averaging (so it drops to
    // ~0 immediately when the bus stops instead of decaying)
    if (gtMs != null && last.gt != null && gtMs > last.gt) {
      const dtSec = (gtMs - last.gt) / 1000;
      if (dtSec > 0.5) m._speedKmh = Math.abs(prog - last.prog) / dtSec * DEG_TO_KM * 3600;
    }
    m._buf.push({ prog, rt, gt: gtMs });
    if (m._buf.length > 3) m._buf.shift();
  }

  // one loop drives every marker: place it at the interpolated past position
  function tickMarkers(now) {
    const renderT = now - INTERP_DELAY_MS;
    for (const [key, m] of busMarkers) {
      const lp = m._lp, buf = m._buf;
      if (!lp || !buf || !buf.length) continue;
      let prog;
      if (buf.length === 1 || renderT <= buf[0].rt) {
        prog = buf[0].prog;
      } else if (renderT >= buf[buf.length - 1].rt) {
        prog = buf[buf.length - 1].prog;   // caught up to the newest fix: hold (lag, never overshoot)
      } else {
        let i = 0;
        while (i < buf.length - 1 && buf[i + 1].rt < renderT) i++;
        const a = buf[i], b = buf[i + 1];
        prog = a.prog + (b.prog - a.prog) * ((renderT - a.rt) / (b.rt - a.rt));
      }
      m._dispProg = prog;
      const p = pointAtProgress(lp, prog);
      setLatLngSubpixel(m, p.lat, p.lng);
      m._busPosCur = p;
      if (activeSelection?.busKey === key) updateSplit(p);
    }
    requestAnimationFrame(tickMarkers);
  }
  requestAnimationFrame(tickMarkers);

  async function refresh() {
    let total = 0, anyErr = false, minAge = null;
    await Promise.all(LINES.map(async LINE => {
      if (!LINE.workerUrl) return;
      try {
        const res = await fetch(LINE.workerUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const snap = await res.json();
        const valid = (snap.buses || []).filter(b => b.lat != null && b.lng != null);
        liveCounts[LINE.id] = valid.length;
        total += valid.length;

        const seen = new Set();
        valid.forEach(b => {
          const a = gpsAge(b.src_updated_at);
          if (a != null && (minAge == null || a < minAge)) minAge = a;
          const key = `${LINE.id}:${b.bus}`;
          seen.add(key);
          const dir = sensDir(b.sens);
          const pos = snapToLine(routePts[LINE.id]?.[dir], b.lat, b.lng);
          const gt = gpsTimeMs(b.src_updated_at);
          const ll = L.latLng(pos.lat, pos.lng);

          if (busMarkers.has(key)) {
            const m = busMarkers.get(key);
            m._busPos = pos; m._busData = b;
            // ingestFix updates m._busDir (it needs the previous one to spot reversals)
            ingestFix(m, LINE.id, dir, pos, gt);
          } else {
            const m = L.marker(ll, { icon: busIcon(LINE.color, LINE.colorRgb), zIndexOffset: 1000 }).addTo(map);
            m._busPos = pos; m._busDir = dir; m._busData = b;
            m._busKey = key; m._busPosCur = pos;
            m._buf = null; m._lp = null; m._speedKmh = null;
            ingestFix(m, LINE.id, dir, pos, gt); // seeds the sample buffer
            m.on("click", e => {
              L.DomEvent.stopPropagation(e);
              activeSelection = { busKey: key, lineId: LINE.id };
              selectedLineId = LINE.id;
              setSheet(false); // collapse the line list so the callout has room
              selectLine(LINE.id, m._busDir, m._busPosCur ?? m._busPos);
              showCallout(LINE, m._busData, m);
              syncChips(); syncSheetHead();
            });
            busMarkers.set(key, m);
          }
        });

        for (const [key, m] of busMarkers)
          if (key.startsWith(`${LINE.id}:`) && !seen.has(key)) {
            map.removeLayer(m);
            busMarkers.delete(key);
            railBusY.delete(key);
          }
      } catch { anyErr = true; }
    }));

    if (activeSelection) {
      const m = busMarkers.get(activeSelection.busKey);
      if (m) {
        selectLine(activeSelection.lineId, m._busDir, m._busPosCur ?? m._busPos);
        const LINE = LINES.find(L_ => L_.id === activeSelection.lineId);
        if (LINE) showCallout(LINE, m._busData, m);
      } else resetSelection();
    }

    setStatus(total, anyErr && total === 0);
    syncChips();
    syncSheetHead();
    renderLineCards();
    renderInfoStats();
    firstDataResolved();
    return minAge;
  }

  function setStatus(n, stale) {
    // pills live on the splash, the mobile topbar and the desktop rail
    document.querySelectorAll(".live-pill").forEach(p => p.classList.toggle("stale", stale));
    document.querySelectorAll(".live-label").forEach(el => el.textContent = stale ? "HORS LIGNE" : "EN DIRECT");
    document.querySelectorAll(".live-count").forEach(el => el.textContent = `· ${n} bus`);
  }

  // ── desktop rail (lines list + search) ──
  const railLinesEl = $("#rail-lines");
  const railSearchEl = $("#rail-search");
  let railQuery = "";
  railSearchEl.addEventListener("input", () => {
    railQuery = railSearchEl.value.trim().toLowerCase();
    renderRail();
  });

  let openedStopMarker = null;
  function focusStation(name) {
    const pos = stationPos.get(name);
    if (!pos) return;
    map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16), { animate: true });
    if (openedStopMarker) openedStopMarker.closeTooltip();
    openedStopMarker = stopMarkers.get(name) ?? null;
    if (openedStopMarker) openedStopMarker.openTooltip();
  }

  // shared station-list markup (desktop rail row + mobile bottom sheet)
  function buildStopList(LINE, container) {
    const stations = LINE.stations || [];
    container.style.setProperty("--cc", LINE.color);
    container.innerHTML = `<div class="rr-stops-inner">${stations.map((s, i) => {
      const term = i === 0 || i === stations.length - 1;
      const pos = stationPos.get(s);
      return `<button class="rr-stop${term ? " terminus" : ""}" data-stop="${s}"${pos ? "" : " disabled"}><span class="dot"></span><span>${s}</span>${term ? '<span class="rr-term-tag">terminus</span>' : ""}</button>`;
    }).join("")}</div>`;
    container.querySelectorAll(".rr-stop:not([disabled])").forEach(stopBtn => {
      stopBtn.addEventListener("click", () => { focusStation(stopBtn.dataset.stop); setSheet(false); });
    });
    return container.querySelector(".rr-stops-inner");
  }

  // live bus dots inside an expanded stop list. ns namespaces the y-memory so the
  // desktop rail and the mobile sheet (different layouts) don't fight over it.
  const railBusY = new Map(); // `${ns}:${busKey}` → last rendered y, so re-renders glide
  function placeRailBuses(LINE, inner, ns) {
    if (!inner || inner.offsetParent === null) return; // hidden: offsets would all read 0
    inner.querySelectorAll(".rr-bus").forEach(d => d.remove()); // refresh dots on a stable list
    const stopEls = inner.querySelectorAll(".rr-stop");
    if (!stopEls.length) return;
    const centerY = el => el.offsetTop + el.offsetHeight / 2;
    for (const [key, m] of busMarkers) {
      if (!key.startsWith(`${LINE.id}:`)) continue;
      const place = railPlacement(LINE, m._busDir, m._busPos);
      if (!place) continue;
      const yi = centerY(stopEls[place.i]);
      const y = yi + (centerY(stopEls[place.j]) - yi) * place.f;
      const dot = document.createElement("span");
      dot.className = "rr-bus";
      const yKey = `${ns}:${key}`;
      const prev = railBusY.get(yKey);
      dot.style.top = `${prev ?? y}px`;
      inner.appendChild(dot);
      if (prev != null && Math.abs(prev - y) > 0.5) {
        void dot.offsetTop; // commit the start position so the transition runs
        dot.style.top = `${y}px`;
      }
      railBusY.set(yKey, y);
    }
  }

  let lastExpandedId = null; // animate the stop list only when it newly unfolds
  function renderRail() {
    const match = LINE => !railQuery
      || LINE.name.toLowerCase().includes(railQuery)
      || endpointsOf(LINE).toLowerCase().includes(railQuery)
      || (LINE.stations || []).some(s => s.toLowerCase().includes(railQuery));
    const shown = LINES.filter(match);

    railLinesEl.innerHTML = "";
    if (!shown.length) {
      railLinesEl.innerHTML = `<div class="rail-empty">Aucune ligne ne correspond à « ${railSearchEl.value} ».</div>`;
      return;
    }
    let expanded = null; // { LINE, inner } of the unfolded row, for bus dots
    shown.forEach(LINE => {
      const sel = selectedLineId === LINE.id;
      const stations = LINE.stations || [];
      const row = document.createElement("div");
      row.className = "rail-row" + (sel ? " sel" : "");
      row.style.setProperty("--cc", LINE.color);

      const btn = document.createElement("button");
      btn.className = "rail-row-btn";
      btn.innerHTML = `
        <span class="rr-badge">${LINE.name}</span>
        <span class="rr-main">
          <span class="rr-name">${endpointsOf(LINE)}</span>
          <span class="rr-meta">
            <span class="rr-live"><span class="ping"><span class="ping-core"></span><span class="ping-wave"></span></span>${liveCounts[LINE.id]} en direct</span>
            <small>${stations.length} arrêts</small>
          </span>
        </span>
        <span class="rr-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12 H19 M13 6 L19 12 L13 18"/></svg>
        </span>`;
      btn.addEventListener("click", () => sel ? resetSelection() : chooseLine(LINE));
      row.appendChild(btn);

      if (sel && stations.length) {
        const wrap = document.createElement("div");
        wrap.className = "rr-stops" + (lastExpandedId !== LINE.id ? " anim" : "");
        if (wrap.classList.contains("anim"))
          // .anim clips overflow while unfolding, which would keep shaving the
          // left edge off the bus dots; drop it once the animation is done
          wrap.addEventListener("animationend", () => wrap.classList.remove("anim"), { once: true });
        const inner = buildStopList(LINE, wrap);
        row.appendChild(wrap);
        expanded = { LINE, inner };
      }
      railLinesEl.appendChild(row);
    });
    if (expanded) placeRailBuses(expanded.LINE, expanded.inner, "rail"); // rows are in the DOM now
    lastExpandedId = selectedLineId;
  }

  const legendEl = $("#map-legend");
  function renderLegend() {
    legendEl.innerHTML = LINES.map(L_ => `
      <span class="lg-item${selectedLineId && selectedLineId !== L_.id ? " dim" : ""}">
        <span class="lg-swatch" style="background:${L_.color}"></span>${L_.name}
      </span>`).join("");
  }

  // ── bottom sheet chips ──
  const chipsEl = $("#line-chips");

  // mobile equivalent of the desktop rail's expanded row: the selected line's
  // station list with live bus dots, shown when the sheet is dragged open
  const sheetStopsEl = $("#sheet-stops");
  let sheetStopsLineId = null;
  function renderSheetStops() {
    if (!selectedLineId) {
      sheetStopsEl.innerHTML = `<div class="rail-empty">Choisissez une ligne pour voir ses arrêts et les bus en direct.</div>`;
      sheetStopsLineId = null;
      return;
    }
    const LINE = LINES.find(L_ => L_.id === selectedLineId);
    // rebuild only when the line changes, so the list keeps its scroll across refreshes
    if (sheetStopsLineId !== selectedLineId) {
      buildStopList(LINE, sheetStopsEl);
      sheetStopsLineId = selectedLineId;
    }
    placeRailBuses(LINE, sheetStopsEl.querySelector(".rr-stops-inner"), "sheet");
  }

  function syncChips() {
    renderRail();
    renderLegend();
    renderSheetStops();
    const keepX = chipsEl.scrollLeft, keepY = chipsEl.scrollTop;
    chipsEl.innerHTML = "";
    LINES.forEach(LINE => {
      const sel = selectedLineId === LINE.id;
      const btn = document.createElement("button");
      btn.className = "chip" + (sel ? " sel" : "");
      btn.style.setProperty("--cc", LINE.color);
      btn.innerHTML = `
        <span class="chip-badge">${LINE.name}</span>
        <span class="chip-text"><b>${endpointsOf(LINE)}</b>
        <small>${liveCounts[LINE.id]} bus en direct · ${(LINE.stations || []).length} arrêts</small></span>`;
      // keep the sheet as-is: collapsed shows the route on the map, expanded
      // reveals this line's stops below — no forced collapse
      btn.addEventListener("click", () => sel ? resetSelection() : chooseLine(LINE));
      chipsEl.appendChild(btn);
    });
    chipsEl.scrollLeft = keepX;
    chipsEl.scrollTop = keepY;
  }
  function syncSheetHead() {
    const total = Object.values(liveCounts).reduce((a, b) => a + b, 0);
    if (selectedLineId) {
      const LINE = LINES.find(L_ => L_.id === selectedLineId);
      $("#sheet-title").textContent = `${LINE.name} · ${endpointsOf(LINE)}`;
      $("#sheet-sub").textContent = sheet.classList.contains("expanded") ? "Arrêts et bus en direct" : "Glisser pour les arrêts";
      $("#mc-sub").textContent = `${LINE.name} · ${endpointsOf(LINE)}`;
    } else {
      $("#sheet-title").textContent = `${LINES.length} lignes en service`;
      $("#sheet-sub").textContent = `${total} bus`;
      $("#mc-sub").textContent = "Réseau complet";
    }
    $("#rail-total").textContent = `${total} bus actifs`;
  }
  function fitLine(LINE) {
    const pts = routePts[LINE.id]?.aller || routePts[LINE.id]?.retour;
    if (pts?.length) map.fitBounds(L.latLngBounds(ptsToLatLng(pts)).pad(0.12));
  }

  // ── bottom sheet: drag/tap to expand, wheel to scroll chips ──
  const sheet = $("#bottom-sheet");
  function setSheet(open) {
    sheet.classList.toggle("expanded", open);
    if (open) renderSheetStops(); // place bus dots now the list has real layout
    syncSheetHead();              // sub-hint depends on expanded state
  }
  for (const el of [sheet.querySelector(".sheet-handle"), sheet.querySelector(".sheet-head")]) {
    let startY = null;
    el.addEventListener("pointerdown", e => {
      startY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointerup", e => {
      if (startY == null) return;
      const dy = startY - e.clientY;
      if (dy > 24) setSheet(true);
      else if (dy < -24) setSheet(false);
      else setSheet(!sheet.classList.contains("expanded")); // simple tap toggles
      startY = null;
    });
  }
  // horizontal chip strip: let desktop mice scroll it with the wheel
  chipsEl.addEventListener("wheel", e => {
    if (sheet.classList.contains("expanded")) return; // vertical list scrolls natively
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      chipsEl.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // …and drag-scroll it like a touch surface (touch already scrolls natively)
  let chipDrag = null;
  let suppressChipClick = false;
  chipsEl.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse") return;
    chipDrag = {
      id: e.pointerId, startX: e.clientX, startY: e.clientY,
      scrollX: chipsEl.scrollLeft, scrollY: chipsEl.scrollTop, moved: false,
    };
  });
  chipsEl.addEventListener("pointermove", e => {
    if (!chipDrag || e.pointerId !== chipDrag.id) return;
    const dx = e.clientX - chipDrag.startX;
    const dy = e.clientY - chipDrag.startY;
    if (!chipDrag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      chipDrag.moved = true;
      chipsEl.setPointerCapture(e.pointerId);
      chipsEl.classList.add("dragging");
    }
    if (chipDrag.moved) {
      chipsEl.scrollLeft = chipDrag.scrollX - dx;
      chipsEl.scrollTop = chipDrag.scrollY - dy;
    }
  });
  for (const ev of ["pointerup", "pointercancel"]) {
    chipsEl.addEventListener(ev, () => {
      if (!chipDrag) return;
      suppressChipClick = chipDrag.moved;
      chipDrag = null;
      chipsEl.classList.remove("dragging");
      setTimeout(() => { suppressChipClick = false; }, 0);
    });
  }
  // a drag must not trigger the chip under the cursor
  chipsEl.addEventListener("click", e => {
    if (suppressChipClick) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ── lines screen ──
  const cardsEl = $("#line-cards");
  function renderLineCards() {
    cardsEl.innerHTML = "";
    LINES.forEach(LINE => {
      const card = document.createElement("button");
      card.className = "line-card";
      card.style.setProperty("--cc", LINE.color);
      card.innerHTML = `
        <span class="lc-badge">${LINE.name}</span>
        <span class="lc-body">
          <b>${endpointsOf(LINE)}</b>
          <span class="lc-meta">${(LINE.stations || []).length} arrêts</span>
          <span class="lc-live">
            <span class="ping"><span class="ping-core"></span><span class="ping-wave"></span></span>
            ${liveCounts[LINE.id]} en direct
          </span>
        </span>
        <span class="lc-arrow">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12 H19 M13 6 L19 12 L13 18"/></svg>
        </span>`;
      card.addEventListener("click", () => { chooseLine(LINE); switchTab("map"); });
      cardsEl.appendChild(card);
    });
    const note = document.createElement("div");
    note.className = "lines-note";
    note.innerHTML = `<b>Données en temps réel</b>
      <span>Positions mises à jour toutes les 10 secondes via les balises GPS embarquées.
      Horaires donnés à titre indicatif.</span>`;
    cardsEl.appendChild(note);
  }

  // ── info screen stats ──
  function renderInfoStats() {
    const total = Object.values(liveCounts).reduce((a, b) => a + b, 0);
    const stops = new Set();
    LINES.forEach(L_ => (L_.stations || []).forEach(s => stops.add(s)));
    $("#info-stats").innerHTML = [
      [LINES.length, "lignes"],
      [total, "bus en direct"],
      [stops.size, "arrêts"],
      ["10 s", "rafraîchissement"],
    ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  }

  // per-line structural facts: vehicles assigned + actual route length (sum of the
  // geojson polyline, not the straight-line distance between termini). Both stay
  // true no matter how much more telemetry is logged — no time-windowed counts.
  const LINE_FACTS = {
    l01: { buses: 4, km: "~24 km" },
    l02: { buses: 2, km: "~25 km" },
    l03: { buses: 2, km: "~21 km" },
  };
  function renderInfoFacts() {
    const el = $("#info-lines");
    if (!el) return;
    el.innerHTML = LINES.map(L_ => {
      const f = LINE_FACTS[L_.id] || {};
      const meta = [f.buses && `${f.buses} bus`, f.km && `${f.km} de long`]
        .filter(Boolean).join(" · ");
      return `<div class="lf"><span class="lf-badge" style="background:${L_.color}">${L_.name}</span>
        <div class="lf-main"><b>${endpointsOf(L_)}</b><span>${meta}</span></div></div>`;
    }).join("");
  }

  // ── tabs ──
  const tabs = { map: $("#screen-map"), lines: $("#screen-lines"), info: $("#screen-info") };
  function switchTab(name) {
    Object.entries(tabs).forEach(([k, el]) => (el.hidden = k !== name));
    document.querySelectorAll("#bottom-nav button").forEach(b =>
      b.classList.toggle("on", b.dataset.tab === name));
    if (name === "map") requestAnimationFrame(() => map.invalidateSize());
  }
  document.querySelectorAll("#bottom-nav button").forEach(b =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // desktop reaches the info screen from the rail; its close button returns to the map
  renderInfoFacts();
  $("#rail-info-btn")?.addEventListener("click", () => switchTab("info"));
  $("#info-close")?.addEventListener("click", () => switchTab("map"));

  // desktop layout has no tabs; make sure the map screen is active when crossing the breakpoint
  const mqDesktop = window.matchMedia("(min-width: 1024px)");
  mqDesktop.addEventListener("change", () => { if (mqDesktop.matches) switchTab("map"); });

  // ── splash → app ──
  // The beacons publish every ~10 s and a fixed 10 s poll aliases against that
  // (the displayed age gets stuck cycling e.g. 9→19 s). Instead, schedule each
  // poll just after the next fix should land: latest fix time + 10 s + margin.
  const POLL_MARGIN_MS = 2000;
  async function refreshLoop() {
    const minAge = await refresh(); // seconds since the freshest GPS fix, or null
    let delay = REFRESH_MS;
    if (minAge != null)
      delay = REFRESH_MS - ((minAge * 1000) % REFRESH_MS) + POLL_MARGIN_MS;
    setTimeout(refreshLoop, Math.max(3000, Math.min(delay, REFRESH_MS + POLL_MARGIN_MS)));
  }
  refreshLoop();

  await Promise.race([firstData, new Promise(r => setTimeout(r, 5000))]);
  $("#splash-loading").hidden = true;
  const enter = $("#enter-btn");
  enter.hidden = false;
  // mount the app behind the splash so Leaflet sizes itself before reveal
  $("#app").hidden = false;
  requestAnimationFrame(() => {
    map.invalidateSize();
    if (homeBounds) map.fitBounds(homeBounds, { animate: false });
  });
  enter.addEventListener("click", () => {
    $("#splash").classList.add("gone");
    requestAnimationFrame(() => map.invalidateSize());
    setTimeout(() => $("#splash").remove(), 600);
  });
})();
