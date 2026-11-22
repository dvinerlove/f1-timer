/* fit-check: exercises the REAL fitXF/dedupe from live.js against a known-good
   OpenF1 session (2024 Brazilian GP race) and the Interlagos geojson.
   Run: node fit-test.js  -> prints metrics, exits non-zero on regression. */
const enc = encodeURIComponent;
const { fitXF, dedupe } = await import("./live.js");

const gj = await (await fetch(
  "https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits/br-1940.geojson"
)).json();
const coords = gj.features[0].geometry.coordinates;
const mid = (a) => (Math.min(...a) + Math.max(...a)) / 2;
const cosLat = Math.cos((mid(coords.map((c) => c[1])) * Math.PI) / 180);
const pts = coords.map(([lon, lat]) => [lon * cosLat, -lat]);
const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
const minX = Math.min(...xs), minY = Math.min(...ys);
const sc = 82 / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
const T = pts.map(([x, y]) => [(x - minX) * sc, (y - minY) * sc]);

const L = await (await fetch(
  "https://api.openf1.org/v1/location?session_key=9636" +
  `&date>=${enc("2024-11-03T16:00:00Z")}&date<=${enc("2024-11-03T16:03:00Z")}`)).json();
const P = dedupe(
  L.filter((p) => (p.x || p.y) && isFinite(p.x) && isFinite(p.y))
   .map((p) => [p.x, p.y]));
console.log("deduped pts:", P.length);

const xf = fitXF(P, T);
if (!xf) { console.log("FAIL: fit rejected a known-good feed"); process.exit(1); }
/* spot-check: a real point must land inside the svg box */
const [px, py] = xf(P[0][0], P[0][1]);
console.log("sample map:", px.toFixed(1), py.toFixed(1));
if (!(px > -10 && px < 110 && py > -10 && py < 110)) {
  console.log("FAIL: mapped point outside svg bounds"); process.exit(1);
}
console.log("PASS");
