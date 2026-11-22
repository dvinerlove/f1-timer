/* LIGHTS OUT — countdown to the next F1 race.
   Data: jolpica (Ergast-compatible), open-meteo, bacinger/f1-circuits GeoJSON. */
"use strict";

const $ = (s) => document.querySelector(s);
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEMO = new URLSearchParams(location.search).get("demo");

const API_NEXT = "https://api.jolpi.ca/ergast/f1/current/next.json";
const GEO_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits/";
const WX_URL = (lat, lon) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
  `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&timezone=auto`;

/* ergast circuitId -> f1-circuits geojson file id (all 2026 rounds + common others) */
const CIRCUIT_GEO = {
  albert_park: "au-1953", shanghai: "cn-2004", suzuka: "jp-1962",
  miami: "us-2022", villeneuve: "ca-1978", monaco: "mc-1929",
  catalunya: "es-1991", red_bull_ring: "at-1969", silverstone: "gb-1948",
  spa: "be-1925", hungaroring: "hu-1986", zandvoort: "nl-1948",
  monza: "it-1922", madring: "es-2026", baku: "az-2016",
  sepang: "my-1999", marina_bay: "sg-2008", americas: "us-2012",
  rodriguez: "mx-1962", interlagos: "br-1940", vegas: "us-2023",
  losail: "qa-2004", yas_marina: "ae-2009",
  bahrain: "bh-2002", jeddah: "sa-2021", imola: "it-1953",
  portimao: "pt-2008", nurburgring: "de-1927", hockenheimring: "de-1932",
  istanbul: "tr-2005", kyalami: "za-1961", ricard: "fr-1969",
  watkins_glen: "us-1956", indianapolis: "us-1909", jacarepagua: "br-1977",
  galvez: "ar-1952", sochi: "ru-2014",
};

/* offline / API-down fallback: remaining 2026 rounds (race start, UTC) */
const FALLBACK = [
  { round: 20, name: "Brazilian Grand Prix", circuitId: "interlagos",
    circuit: "Autódromo José Carlos Pace", locality: "São Paulo", country: "Brazil",
    lat: -23.7036, long: -46.6997, at: "2026-11-08T17:00:00Z" },
  { round: 21, name: "Las Vegas Grand Prix", circuitId: "vegas",
    circuit: "Las Vegas Strip Street Circuit", locality: "Las Vegas", country: "USA",
    lat: 36.1147, long: -115.173, at: "2026-11-22T04:00:00Z" },
  { round: 22, name: "Qatar Grand Prix", circuitId: "losail",
    circuit: "Lusail International Circuit", locality: "Lusail", country: "Qatar",
    lat: 25.49, long: 51.4542, at: "2026-11-29T16:00:00Z" },
  { round: 23, name: "Abu Dhabi Grand Prix", circuitId: "yas_marina",
    circuit: "Yas Marina Circuit", locality: "Abu Dhabi", country: "UAE",
    lat: 24.4672, long: 54.6031, at: "2026-12-06T13:00:00Z" },
];

const SESSION_LABELS = {
  FirstPractice: "FP1", SecondPractice: "FP2", ThirdPractice: "FP3",
  SprintQualifying: "SQ", SprintShootout: "SQ", Sprint: "SPRINT",
  Qualifying: "QUALI",
};
const SESSION_MINUTES = { RACE: 180, SPRINT: 60 }; /* others 75 */

let race = null;          /* current normalized race */
let sessionEls = [];      /* [{el, at, mins, label}] */
let trackPts = null;      /* projected circuit outline, svg units */
let trackReady;           /* resolves once track geojson processed */
const trackReadyP = new Promise((res) => (trackReady = res));
let liveOn = false;       /* live.js started */

const isoToMs = (d, t) => Date.parse(`${d}T${t || "00:00:00Z"}`);

function normalizeErgast(r) {
  const sessions = [];
  for (const [key, label] of Object.entries(SESSION_LABELS)) {
    const s = r[key];
    if (s?.date) sessions.push({ label, at: isoToMs(s.date, s.time), key });
  }
  const raceAt = isoToMs(r.date, r.time);
  sessions.push({ label: "RACE", at: raceAt, key: "Race" });
  sessions.sort((a, b) => a.at - b.at);
  const L = r.Circuit.Location;
  return {
    season: r.season, round: +r.round, name: r.raceName,
    circuit: r.Circuit.circuitName, circuitId: r.Circuit.circuitId,
    locality: L.locality, country: L.country,
    lat: +L.lat, long: +L.long, at: raceAt, sessions,
  };
}

function normalizeFallback(f) {
  return { ...f, season: "2026", at: Date.parse(f.at),
           sessions: [{ label: "RACE", at: Date.parse(f.at), key: "Race" }] };
}

async function getRace() {
  try {
    const j = await (await fetch(API_NEXT)).json();
    const r = j?.MRData?.RaceTable?.Races?.[0];
    if (r) return normalizeErgast(r);
  } catch { /* offline or API hiccup */ }
  const now = Date.now();
  const f = FALLBACK.find((f) => Date.parse(f.at) + 4 * 3600e3 > now);
  return f ? normalizeFallback(f) : null;
}

/* ── render ──────────────────────────────────────── */

function renderRace(r) {
  race = r;
  document.body.classList.remove("racing");

  const m = r.name.match(/^(.*?)( Grand Prix)?$/i);
  $("#race-name").innerHTML =
    `<span>${m[1].toUpperCase()}</span> <em>${m[2] ? "GRAND PRIX" : ""}</em>`;
  $("#season").textContent = `${r.season} FIA FORMULA 1 WORLD CHAMPIONSHIP · ROUND ${r.round}`;
  $("#circuit-line").innerHTML =
    `<b>${r.circuit}</b> — ${r.locality}, ${r.country}`;

  const ol = $("#sessions");
  ol.innerHTML = "";
  sessionEls = r.sessions.map((s) => {
    const li = document.createElement("li");
    const d = new Date(s.at);
    li.innerHTML =
      `<span class="s-name">${s.label}</span>` +
      `<span class="s-when">${d.toLocaleDateString(undefined,
        { weekday: "short", day: "numeric", month: "short" }).toUpperCase()}</span>` +
      `<span class="s-when">${d.toLocaleTimeString(undefined,
        { hour: "2-digit", minute: "2-digit" })}</span>`;
    ol.appendChild(li);
    return { el: li, at: s.at, mins: SESSION_MINUTES[s.label] || 75 };
  });

  $("#track-caption").textContent = "CIRCUIT MAP — LOADING";
  loadTrack(r).catch(() => {
    $("#track-caption").textContent = `${r.circuit} — MAP UNAVAILABLE`;
    trackReady(null);
  });
  loadWeather(r).catch(() => { $("#wx").textContent = ""; });
  loadStandings(r); /* championship context entering this round */
  loadResults(r); /* previous-round classification */
}

/* ── previous race results ───────────────────────── */

const TEAM_COL = {
  "Red Bull": "#3671C6", McLaren: "#F47600", Ferrari: "#F91536",
  Mercedes: "#6CD3BF", "Aston Martin": "#229971", Williams: "#64C4FF",
  Cadillac: "#C0C8D0", Audi: "#52e07d", "RB F1 Team": "#6692FF",
  "Racing Bulls": "#6692FF", Sauber: "#52e07d", "Kick Sauber": "#52e07d",
  "Alpine": "#0093CC", "Alpine F1 Team": "#0093CC",
  "Haas": "#B6BABD", "Haas F1 Team": "#B6BABD",
};

let lastRace = null; /* ergast: most recent finished race of this season */

async function loadResults(r) {
  const btn = $("#res-btn");
  try {
    const base = `https://api.jolpi.ca/ergast/f1/${r.season}/last`;
    const [res, fl] = await Promise.all([
      fetch(`${base}/results.json`).then((x) => x.json()),
      fetch(`${base}/fastest/1/results.json`).then((x) => x.json()),
    ]);
    const R = res?.MRData?.RaceTable?.Races?.[0];
    if (!R?.Results?.length) return;
    /* jolpica omits FastestLap detail — only the holder's row is known */
    lastRace = { ...R,
      flNum: +fl?.MRData?.RaceTable?.Races?.[0]
        ?.Results?.[0]?.Driver?.permanentNumber || null };
    btn.textContent = `RESULTS — ${R.raceName.toUpperCase()} ↗`;
    btn.hidden = false;
  } catch { /* offline — button stays hidden */ }
}

function showResults() {
  const el = $("#results"), R = lastRace;
  if (!R) return;
  const res = R.Results || [];
  const fl = res.find((x) => +x.Driver.permanentNumber === R.flNum);
  el.innerHTML = `<div class="res-card" role="dialog" aria-label="Race results">
    <div class="fin-flag"><i></i>RACE RESULTS<i></i></div>
    <div class="fin-race">${R.raceName} · ROUND ${R.round} · ${new Date(
      `${R.date}T${R.time || "00:00:00Z"}`).toLocaleDateString(undefined,
      { day: "numeric", month: "short", year: "numeric" }).toUpperCase()}</div>
    <ol class="res-list">${res.map((x) => {
      const col = TEAM_COL[x.Constructor?.name] || "#8a8f98";
      const out = !/finished|lapped|^\+/i.test(x.status || "");
      const isFl = x === fl;
      return `<li class="res-row${+x.position <= 3 ? ` p${x.position - 1}` : ""}${out ? " dnf" : ""}">
        <b class="fin-pos">${x.position}</b>
        <i class="bar-c" style="background:${col}"></i>
        <span class="res-tla">${x.Driver.code || ""}</span>
        <span class="res-name">${x.Driver.givenName} ${x.Driver.familyName}</span>
        <span class="res-team">${x.Constructor?.name || ""}</span>
        <b class="res-gap">${x.Time?.time || x.status || "—"}</b>
        ${isFl ? `<b class="fl-mark">FL</b>` : ""}
        <b class="res-pts">${x.points}<i> PTS</i></b>
      </li>`;
    }).join("")}</ol>
    ${fl ? `<div class="fin-fl">FASTEST LAP · ` +
      `${fl.Driver.givenName} ${fl.Driver.familyName}`.toUpperCase() + `</div>` : ""}
    <div class="fin-hint">ESC OR TAP TO CLOSE</div>
  </div>`;
  el.hidden = false;
  el.onclick = (e) => { if (e.target === el) el.hidden = true; };
  const card = el.querySelector(".res-card");
  card.onclick = () => { el.hidden = true; };
}

addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#results").hidden = true; }
});
$("#res-btn").addEventListener("click", showResults);

/* OpenF1: standings after the most recent completed race of this season */
async function loadStandings(r) {
  const el = $("#standings");
  try {
    const ss = await (await fetch(
      `https://api.openf1.org/v1/sessions?year=${r.season}&session_name=Race`)).json();
    const done = ss.filter((s) => !s.is_cancelled && Date.parse(s.date_start) < r.at)
      .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start))[0];
    if (!done?.session_key) return;
    const [champ, drvs] = await Promise.all([
      fetch(`https://api.openf1.org/v1/championship_drivers?session_key=${done.session_key}`).then((x) => x.json()),
      fetch(`https://api.openf1.org/v1/drivers?session_key=${done.session_key}`).then((x) => x.json()),
    ]);
    const tla = new Map(drvs.map((d) => [d.driver_number, d.name_acronym]));
    const top = champ.sort((a, b) => a.position_current - b.position_current)
      .slice(0, 3);
    if (!top.length || top[0].points_current == null) return;
    el.innerHTML = "C'SHIP · " + top.map((c) =>
      `P${c.position_current} <b>${tla.get(c.driver_number) || "#" + c.driver_number} ${Math.round(c.points_current)}</b>`)
      .join(" · ");
    el.hidden = false;
  } catch { /* no standings data — line stays hidden */ }
}

/* ── circuit map ─────────────────────────────────── */

async function loadTrack(r) {
  const id = CIRCUIT_GEO[r.circuitId];
  if (!id) { $("#track-caption").textContent = `${r.circuit} — NO MAP DATA`;
    trackReady(null); return; }

  const gj = await (await fetch(GEO_BASE + id + ".geojson")).json();
  const geom = (gj.features ? gj.features[0] : gj).geometry;
  let parts = geom.type === "LineString" ? [geom.coordinates]
            : geom.type === "MultiLineString" ? geom.coordinates : [];
  if (!parts.length) return;
  const coords = parts.reduce((a, b) => (b.length > a.length ? b : a));

  const mid = (arr) => (Math.min(...arr) + Math.max(...arr)) / 2;
  const cosLat = Math.cos((mid(coords.map((c) => c[1])) * Math.PI) / 180);
  const pts = coords.map(([lon, lat]) => [lon * cosLat, -lat]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
  const PAD = 9, S = 100 - PAD * 2;
  const scale = S / Math.max(w, h);
  const offX = PAD + (S - w * scale) / 2, offY = PAD + (S - h * scale) / 2;
  const proj = pts.map(([x, y]) => [
    +(offX + (x - minX) * scale).toFixed(2),
    +(offY + (y - minY) * scale).toFixed(2),
  ]);

  const d = "M" + proj.map((p) => p.join(",")).join("L") + "Z";
  trackPts = proj;
  const path = $("#track-path"), ghost = $("#track-ghost");
  path.setAttribute("d", d); ghost.setAttribute("d", d);
  const [sx, sy] = proj[0];
  const sf = $("#sf"); sf.setAttribute("cx", sx); sf.setAttribute("cy", sy);

  const comets = $("#comets");
  comets.innerHTML = "";
  if (!RM) {
    path.classList.add("draw");
    const SVG = "http://www.w3.org/2000/svg";
    /* leader furthest ahead -> negative begin offsets trail behind it */
    [{ r: 2.4, o: 1, begin: "-0.30s" }, { r: 1.7, o: 0.7, begin: "-0.15s" },
     { r: 1.1, o: 0.4, begin: "0s" }].forEach(({ r: cr, o, begin }) => {
      const c = document.createElementNS(SVG, "circle");
      c.setAttribute("r", cr); c.setAttribute("opacity", o);
      const am = document.createElementNS(SVG, "animateMotion");
      am.setAttribute("dur", "9s");
      am.setAttribute("repeatCount", "indefinite");
      am.setAttribute("begin", begin);
      const mp = document.createElementNS(SVG, "mpath");
      mp.setAttribute("href", "#track-path");
      am.appendChild(mp); c.appendChild(am); comets.appendChild(c);
    });
  } else {
    path.setAttribute("stroke-dashoffset", "0");
  }
  $("#track-caption").textContent =
    `${r.circuit} — ${r.locality}, ${r.country}`.toUpperCase();
  trackReady(trackPts);
}

/* ── weather at the circuit ──────────────────────── */

const WMO = (c) =>
  c === 0 ? "CLEAR" : c <= 2 ? "PARTLY CLOUDY" : c === 3 ? "OVERCAST"
  : c <= 48 ? "FOG" : c <= 57 ? "DRIZZLE" : c <= 67 ? "RAIN"
  : c <= 77 ? "SNOW" : c <= 82 ? "RAIN SHOWERS" : c <= 99 ? "THUNDERSTORM" : "—";

async function loadWeather(r) {
  const j = await (await fetch(WX_URL(r.lat, r.long))).json();
  const c = j.current;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const windDir = dirs[Math.round(c.wind_direction_10m / 45) % 8];
  document.body.dataset.wx = c.weather_code;
  document.body.dataset.wd = c.wind_direction_10m;
  $("#wx").innerHTML =
    `TRACK <b>${Math.round(c.temperature_2m)}°C ${WMO(c.weather_code)}</b>` +
    ` · WIND <span class="wind-arrow" style="--wd:${c.wind_direction_10m + 90}deg">→</span>` +
    ` <b>${Math.round(c.wind_speed_10m)} KM/H ${windDir}</b>`;
  if (j.timezone) {
    const fmt = new Intl.DateTimeFormat(undefined,
      { hour: "2-digit", minute: "2-digit", timeZone: j.timezone });
    const tick = () =>
      $("#track-clock").innerHTML = `LOCAL AT TRACK <b>${fmt.format(new Date())}</b>`;
    tick(); setInterval(tick, 30e3);
  }
}

/* ── countdown loop ──────────────────────────────── */

const pad = (n, l = 2) => String(n).padStart(l, "0");
let lastSec = -1, lastMin = -1;

function tick() {
  if (!race) { if (!RM) requestAnimationFrame(tick); return; }
  const diff = race.at - Date.now();
  const racing = DEMO ? true : diff <= 0;
  if (racing && !liveOn) { liveOn = true; startLive(); }
  document.body.classList.toggle("racing", racing);

  const t = Math.abs(diff);
  const d = Math.floor(t / 864e5), h = Math.floor(t / 36e5) % 24,
        m = Math.floor(t / 6e4) % 60, s = Math.floor(t / 1e3) % 60,
        ms = t % 1000;

  $("#cd-d").textContent = pad(d);
  $("#cd-h").textContent = pad(h);
  $("#cd-m").textContent = pad(m);
  $("#cd-s").textContent = pad(s);
  $("#cd-ms").textContent = pad(ms, 3);

  if (s !== lastSec) {
    lastSec = s;
    if (!DEMO) $("#eyebrow").textContent = racing
      ? "LIGHTS OUT · RACE CLOCK" : "NEXT RACE · LIGHTS OUT IN";
    if (!liveOn) document.title =
      `${racing ? "+" : ""}${pad(d)}:${pad(h)}:${pad(m)}:${pad(s)} · ${race.name}`;
    updateSessions();
  }
  if (m !== lastMin) {
    lastMin = m;
    $("#sr-clock").textContent = racing
      ? `${race.name} in progress`
      : `${d} days, ${h} hours, ${m} minutes until the ${race.name}`;
  }
  if (!RM) requestAnimationFrame(tick);
  /* reduced motion: second-resolution updates via the interval below */
}

function updateSessions() {
  const now = Date.now();
  let nextMarked = false;
  for (const s of sessionEls) {
    const dur = s.mins * 6e4, live = now >= s.at && now < s.at + dur;
    const done = now >= s.at + dur;
    s.el.classList.toggle("done", done);
    s.el.classList.toggle("live", live);
    const next = !done && !live && !nextMarked;
    s.el.classList.toggle("next", next);
    nextMarked ||= next;
  }
}

/* ── live telemetry (lazy-loaded module) ─────────── */

async function startLive() {
  try {
    const pts = await Promise.race([trackReadyP, sleep(6000)]);
    (await import("./live.js")).start({ race, trackPts: pts, demo: DEMO, RM });
  } catch (e) {
    $("#track-caption").textContent = "TELEMETRY MODULE OFFLINE";
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── ambient fx: warp particles + pointer tilt ───── */

function initFx() {
  if (RM) return;
  const cv = $("#fx"), cx = cv.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let W, H;
  const resize = () => {
    W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
  };
  resize(); addEventListener("resize", resize);
  const N = Math.min(110, Math.round(innerWidth / 16));
  const parts = Array.from({ length: N }, () => ({
    x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() || 1,
  }));
  /* rain streaks when open-meteo reports real precipitation at the track */
  const R = 42;
  const drops = Array.from({ length: R }, () => ({
    x: Math.random(), y: Math.random(), v: 0.55 + Math.random() * 0.5,
  }));
  const raining = () => {
    const w = +document.body.dataset.wx;
    return w >= 51 && !(w >= 71 && w <= 77); /* drizzle/rain/showers/tstorm, not snow */
  };
  let warp = 0, prev = 0;
  requestAnimationFrame(function loop(t) {
    const dt = Math.min(0.05, (t - prev) / 1000 || 0.016); prev = t;
    warp += ((document.body.classList.contains("racing") ? 1 : 0) - warp) * dt;
    cx.clearRect(0, 0, W, H);
    if (raining()) {
      const wd = +document.body.dataset.wd || 0;
      const slant = Math.sin((wd * Math.PI) / 180) * 0.10;
      cx.strokeStyle = "rgba(160, 190, 230, 0.10)";
      cx.lineWidth = dpr * 0.7;
      cx.beginPath();
      for (const d of drops) {
        d.y += d.v * dt * (1 + warp);
        if (d.y > 1.04) { d.y = -0.04; d.x = Math.random(); }
        const x = d.x * W, y = d.y * H;
        cx.moveTo(x, y);
        cx.lineTo(x + slant * H * 0.06, y + H * 0.028 + d.v * H * 0.012);
      }
      cx.stroke();
    }
    const sp = 0.10 + warp * 2.4;
    for (const p of parts) {
      p.z -= sp * dt;
      if (p.z <= 0.02) { p.x = Math.random() * 2 - 1; p.y = Math.random() * 2 - 1; p.z = 1; }
      const k = 0.7 / p.z, k2 = 0.7 / (p.z + sp * dt * (2 + warp * 8));
      const x = W / 2 + p.x * k * W * 0.5, y = H / 2 + p.y * k * H * 0.5;
      cx.strokeStyle = `rgba(${warp > 0.4 ? "255,60,40" : "255,170,60"},${(1 - p.z) * (0.055 + warp * 0.30)})`;
      cx.lineWidth = Math.max(0.6, (1 - p.z) * dpr * (1 + warp));
      cx.beginPath();
      cx.moveTo(W / 2 + p.x * k2 * W * 0.5, H / 2 + p.y * k2 * H * 0.5);
      cx.lineTo(x, y);
      cx.stroke();
    }
    requestAnimationFrame(loop);
  });
}

function initTilt() {
  if (RM || !matchMedia("(pointer:fine)").matches) return;
  for (const el of document.querySelectorAll(".cell, .telem")) {
    el.classList.add("tilt");
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      el.style.setProperty("--ry", `${((px - 0.5) * 10).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${((0.5 - py) * 8).toFixed(2)}deg`);
      el.style.setProperty("--mx", `${px * 100}%`);
      el.style.setProperty("--my", `${py * 100}%`);
    });
    el.addEventListener("pointerleave", () => {
      el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg");
    });
  }
}

/* ── boot ────────────────────────────────────────── */

async function boot() {
  const r = await getRace();
  if (!r) {
    $("#eyebrow").textContent = "SEASON COMPLETE";
    $("#race-name").innerHTML = "<span>SEE YOU</span> <em>IN 2027</em>";
    $("#circuit-line").textContent = "ALL ROUNDS DONE — NEW CALENDAR SOON";
    return;
  }
  renderRace(r);
  $("#gantry").classList.add("lit");

  /* poll for the next race once this one is done */
  setInterval(async () => {
    const n = await getRace();
    if (n && (n.round !== race.round || n.name !== race.name)) renderRace(n);
  }, 5 * 60e3);
}

if (RM) setInterval(tick, 1000); else requestAnimationFrame(tick);
initFx();
initTilt();
boot();
