# ZizGo

Live bus tracking for Errachidia, Morocco. Follow every bus on the city's network in real time, from the browser or as an installable PWA.

**ⵕⵕⴰⵛⵉⴷⵢⵢⴰ** · Named after the Ziz river that threads through the oasis.

## Features

- **Live positions**: bus locations refresh every ~10 seconds from on-board GPS beacons, with markers that glide along the route geometry between fixes
- **Direction-aware highlighting**: tap a bus and the path it has already covered dims while the road ahead stays bright
- **Per-line station rail** (desktop): expand a line to see its stations, with live bus dots placed proportionally between stops
- **Dark and light map themes**, with the choice remembered between visits
- **Installable PWA**: works offline for the app shell, fits phone and desktop layouts
- **French UI** with Tifinagh accents, matching the region

## Stack

No framework, no build step. Plain HTML/CSS/JS plus:

- [Leaflet](https://leafletjs.com/) for the map
- [CARTO basemaps](https://carto.com/basemaps/) (Voyager / Dark Matter raster tiles)
- A small [Cloudflare Worker](worker/worker.js) that proxies the transit operator's API and normalizes bus positions

## Project layout

```
index.html            app shell (splash, map screen, lines, info)
css/app.css           all styling, responsive at 1024px
js/app.js             map, live data loop, line/station logic
sw.js                 service worker (cache-first app shell)
manifest.webmanifest  PWA manifest
stations.json         station name → coordinates
lines/l0*.json        per-line config: colors, stations, worker URL
geojson/              route geometry, one file per line and direction
worker/worker.js      Cloudflare Worker proxy (deployed separately)
assets/               icons, logo, splash imagery
```

## Run locally

Any static file server works. For example:

```sh
python -m http.server 8000
```

Then open http://localhost:8000.

Note: the service worker caches the shell aggressively. After editing files, bump the `CACHE` version in [sw.js](sw.js) and hard-refresh (Ctrl+Shift+R).

## Deploy to GitHub Pages

The app uses relative paths throughout, so it works from a subpath (`username.github.io/repo/`) with no configuration:

1. Push the repo to GitHub
2. Repo **Settings → Pages → Source**: select **Deploy from a branch**, branch `main`, folder `/ (root)`
3. Wait for the first deploy, then visit `https://<username>.github.io/<repo>/`

## Live data: the Worker proxy

The transit operator's API is plain-HTTP and has no CORS headers, so the frontend can't call it directly from an HTTPS page. [worker/worker.js](worker/worker.js) runs on Cloudflare Workers (free tier) and:

- accepts `GET /?line=l01` (strict allowlist, no open proxy)
- calls the upstream API and extracts each bus's id, direction, coordinates and GPS timestamp
- returns clean JSON with CORS headers and `Cache-Control: no-store`

To deploy your own: create a Worker in the Cloudflare dashboard, paste in `worker/worker.js`, set `API_HOST` to the upstream hostname, then point `workerUrl` in each `lines/l0*.json` at your worker.

## Adding or editing a line

1. Draw the route in [geojson.io](https://geojson.io) (one LineString per direction) and save to `geojson/`
2. Add station coordinates to `stations.json`
3. Create `lines/l0X.json` with the line's color, station order and worker URL
4. Register the line id in `js/app.js` (`LINE_IDS`) and in the worker's `LINES` map
5. Add the new files to the `SHELL` list in `sw.js` and bump `CACHE`
