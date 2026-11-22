/* live.js — OpenF1 live telemetry. Imported lazily when the race starts
   (or forced via ?demo=<session_key> replay). Zero deps. */
"use strict";

const O = "https://api.openf1.org/v1/";
const $ = (s) => document.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

/* OpenF1 locks ALL api access while a session runs — sponsor accounts only.
   Credentials live in localStorage (f1user/f1pass); token is Bearer, 1h TTL. */
let token = null;
async function authToken() {
  const u = localStorage.getItem("f1user"), p = localStorage.getItem("f1pass");
  if (!u || !p) return null;
  const r = await fetch(O.replace(/v1\/$/, "") + "token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${enc(u)}&password=${enc(p)}`,
  });
  if (!r.ok) return null;
  return (await r.json()).access_token || null;
}

async function jget(path) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(O + path,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    if (r.status === 429) { await sleep(2500 * (i + 1)); continue; }
    if (r.status === 401) {
      if (token) { token = null; continue; } /* expired — refresh once */
      token = await authToken().catch(() => null);
      if (token) continue;
      throw Object.assign(new Error(`401 ${path}`), { gated: true });
    }
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }
  throw new Error(`429 ${path}`);
}

const TYRE = {
  SOFT: ["S", "#d9261c"], MEDIUM: ["M", "#ffd12f"], HARD: ["H", "#e8e8e3"],
  INTERMEDIATE: ["I", "#3fbf4a"], WET: ["W", "#2f7fd0"],
};
const TOTAL_LAPS = {
  albert_park: 58, shanghai: 56, suzuka: 53, miami: 57, villeneuve: 70,
  monaco: 78, catalunya: 66, red_bull_ring: 71, silverstone: 52, spa: 44,
  hungaroring: 70, zandvoort: 72, monza: 53, baku: 51, sepang: 56,
  marina_bay: 62, americas: 56, rodriguez: 71, interlagos: 71,
  vegas: 50, losail: 57, yas_marina: 58,
};
const DRS_LABEL = (d) => d >= 10 ? "OPEN" : d === 8 ? "AVAIL" : "OFF";

/* ── coordinate transform: fit OpenF1 x,y onto the svg outline.
   coarse rotation scan (both mirrors) + trimmed ICP refine.
   nearest-distance is measured to track SEGMENTS, not vertices.
   module-level so fit-check.js can exercise the real code path. ── */
const stats = (pts) => {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const rms = Math.sqrt(
    pts.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / pts.length);
  return { cx, cy, rms };
};
export function fitXF(locPts, T) {
  const sub = locPts.filter((_, i) => i % Math.ceil(locPts.length / 400) === 0);
  const Ts = T.filter((_, i) => i % Math.ceil(T.length / 300) === 0);
  const st = stats(Ts), sl = stats(sub);
  const Tn = Ts.map((p) => [(p[0] - st.cx) / st.rms, (p[1] - st.cy) / st.rms]);
  const Ln = sub.map((p) => [(p[0] - sl.cx) / sl.rms, (p[1] - sl.cy) / sl.rms]);
  const Segs = Tn.map((p, i) => [p, Tn[(i + 1) % Tn.length]]);
  const nearest = (rx, ry) => {
    let d = 1e9, hi = 0, proj = [0, 0];
    for (let k = 0; k < Segs.length; k++) {
      const [a, b] = Segs[k];
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const wx = rx - a[0], wy = ry - a[1];
      const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1e-9)));
      const dd = (wx - t * vx) ** 2 + (wy - t * vy) ** 2;
      if (dd < d) { d = dd; hi = k; proj = [a[0] + t * vx, a[1] + t * vy]; }
    }
    return [d, hi, proj];
  };
  const xform = (deg, flip) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return ([x0, y0]) => {
      const x = x0 * flip, y = y0;
      return [x * c - y * s, x * s + y * c];
    };
  };
  const score = (deg, flip) => {
    const f = xform(deg, flip);
    let err = 0;
    for (const p of Ln) err += nearest(...f(p))[0];
    return Math.sqrt(err / Ln.length);
  };
  let best = { rms: 9, deg: 0, flip: 1 };
  for (const flip of [1, -1])
    for (let deg = 0; deg < 360; deg += 6) {
      const r = score(deg, flip);
      if (r < best.rms) best = { rms: r, deg, flip };
    }
  /* ICP: match nearest -> least-squares rotation step, keep best 80% */
  let { deg, flip } = best;
  for (let it = 0; it < 12; it++) {
    const f = xform(deg, flip);
    const pairs = Ln.map((p) => {
      const s0 = f(p);
      const [d, , t0] = nearest(...s0);
      return { s: s0, t: t0, d };
    }).sort((a, b) => a.d - b.d).slice(0, Math.ceil(Ln.length * 0.8));
    const n = pairs.length;
    let cs = [0, 0], ct = [0, 0], num = 0, den = 0;
    for (const p of pairs) {
      cs[0] += p.s[0]; cs[1] += p.s[1]; ct[0] += p.t[0]; ct[1] += p.t[1];
    }
    cs = cs.map((v) => v / n); ct = ct.map((v) => v / n);
    for (const p of pairs) {
      const xs = p.s[0] - cs[0], ys = p.s[1] - cs[1];
      const xt = p.t[0] - ct[0], yt = p.t[1] - ct[1];
      num += xs * yt - ys * xt; den += xs * xt + ys * yt;
    }
    const dDeg = (Math.atan2(num, den) * 180) / Math.PI;
    deg += dDeg;
    if (Math.abs(dDeg) < 0.02) break;
  }
  /* metrics on inliers (top 80%): rms to line + segment coverage */
  const f = xform(deg, flip);
  const all = Ln.map((p) => {
    const [d, hi] = nearest(...f(p));
    return { d, hi, p };
  }).sort((a, b) => a.d - b.d);
  const inliers = all.slice(0, Math.ceil(all.length * 0.8));
  let err = 0; const hits = new Set();
  for (const e of inliers) { err += e.d; hits.add(e.hi); }
  const rms = Math.sqrt(err / inliers.length), cov = hits.size / Tn.length;
  if (rms > 0.09 || cov < 0.35) return null;
  /* per-axis scale refine on inliers */
  let aN = [0, 0], aD = [0, 0];
  for (const { p } of inliers) {
    const [rx, ry] = f(p);
    const [, , pt] = nearest(rx, ry);
    aN[0] += rx * pt[0]; aD[0] += rx * rx;
    aN[1] += ry * pt[1]; aD[1] += ry * ry;
  }
  const sx = aD[0] > 1e-6 ? aN[0] / aD[0] : 1;
  const sy = aD[1] > 1e-6 ? aN[1] / aD[1] : 1;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return (x0, y0) => {
    const x = (x0 - sl.cx) * flip / sl.rms, y = (y0 - sl.cy) / sl.rms;
    return [st.cx + (x * c - y * s) * sx * st.rms,
            st.cy + (x * s + y * c) * sy * st.rms];
  };
}

/* spatial dedupe — parked cars would otherwise flood a few cells */
export const dedupe = (pts) => {
  const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)];
  const ax = pts.map((p) => p[0]), ay = pts.map((p) => p[1]);
  const cell = Math.max(q(ax, .9) - q(ax, .1), q(ay, .9) - q(ay, .1)) / 30 || 1;
  const seen = new Set();
  return pts.filter(([x, y]) => {
    const k = Math.round(x / cell) + ":" + Math.round(y / cell);
    return !seen.has(k) && seen.add(k);
  });
};

export async function start({ race, trackPts, demo, RM }) {
  /* ── shared state — filled by OpenF1 polls or the official F1 feed ── */
  const drivers = new Map();
  const pos = new Map(), ints = new Map(), stints = new Map(),
        pits = new Map(), lastLap = new Map(), loc = new Map();
  const last = { pos: "", int: "", loc: "", car: "", rc: "",
                 wx: "", otk: "", rad: "" };
  const liveCloud = []; /* accumulated live x,y for on-session fitting */
  const trails = new Map(), prevPos = new Map(), prevPits = new Map();
  const lapHist = new Map(), topSpd = new Map(), radios = new Map();
  const traps = new Map(); /* feed: latest speed-trap readings {I1,I2,FL,ST} */
  const pbest = new Map(); /* feed: personal best lap {t, pos} via TimingStats */
  const bestSec = new Map(); /* feed: best sector times + field rank */
  const pitTime = new Map(); /* feed: last pit-lane transit, seconds */
  let raceLeft = 0, raceLeftAt = 0; /* feed: ExtrapolatedClock remaining */
  let lapStartUtc = 0, drsState = ""; /* feed: lap-start clock + drs flag */
  let secArcs = null;            /* map: sector-activity arc elements */
  const lapSeries = new Map();   /* feed: per-lap position history */
  const statusSeries = [];       /* feed: [{utc,status}] flag timeline */
  const lapStarts = [];          /* feed: utc of each lap start */
  let wxFirst = null;            /* feed: first WeatherDataSeries reading */
  let audioUrl = "";             /* feed: commentary stream uri */
  let lowGrip = "";              /* feed: LOW GRIP / OVERTAKE DISABLED */
  let circuitData = null;        /* multiviewer: corners, marshal secs, pitLoss */
  const grid = new Map(), wasInPit = new Map();
  const segFrac = new Map(); /* feed: last KNOWN lap fraction (0..1) */
  const est = new Map();     /* smoothed estimate driven between anchors */
  const drive = new Map();   /* {inPit, stopped} per car */
  const retired = new Set();
  const fl = { t: 0, n: 0 };
  let maxLap = 0, sel = null, xf = null, pathEl = null, pathLen = 0,
      totalLaps = 0, flNum = 0, feedOn = false;
  const cars = $("#cars"), tower = $("#tower"), trailsEl = $("#trails");
  if (trackPts) { pathEl = $("#track-path"); pathLen = pathEl.getTotalLength(); }

  /* ── tower ── */
  const fmtNum = (v) => isNaN(+v) ? String(v) : `+${(+v).toFixed(3)}`;
  const fmtGap = (v, p) =>
    p === 1 ? "LEADER" : v == null ? "—" : fmtNum(v); /* "+1 LAP" stays text */
  const rowFor = (num) => {
    let li = tower.querySelector(`li[data-n="${num}"]`);
    if (!li) {
      const d = drivers.get(num) || { tla: `#${num}`, col: "#8a8f98" };
      li = document.createElement("li");
      li.dataset.n = num;
      li.innerHTML =
        `<span class="pos"></span><i class="bar-c" style="background:${d.col}"></i>` +
        `<span class="tla">${d.tla}</span><span class="gap"></span>` +
        `<span class="aux"><span class="fl" hidden>FL</span>` +
        `<span class="tyre"></span><span class="pits"></span>` +
        `<span class="delta"></span></span>`;
      li.addEventListener("click", () => { sel = num; renderSel(); });
      li.tabIndex = 0; li.setAttribute("role", "button");
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); sel = num; renderSel();
        }
      });
      tower.appendChild(li);
    }
    return li;
  };

  /* ── car pods on the map (group = dot + tla label) ── */
  const carFor = (num) => {
    let g = cars.querySelector(`g[data-n="${num}"]`);
    if (!g) {
      const d = drivers.get(num) || { col: "#fff", tla: `#${num}` };
      g = document.createElementNS(NS, "g");
      g.setAttribute("class", "car"); g.dataset.n = num;
      g.style.color = d.col;
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", 1.35); c.setAttribute("fill", d.col);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", 2.3); t.setAttribute("y", 1.1);
      t.textContent = d.tla;
      g.append(c, t); cars.appendChild(g);
    }
    return g;
  };
  const trailFor = (num) => {
    let pl = trailsEl.querySelector(`polyline[data-n="${num}"]`);
    if (!pl) {
      pl = document.createElementNS(NS, "polyline");
      pl.dataset.n = num;
      pl.setAttribute("stroke", (drivers.get(num) || { col: "#fff" }).col);
      trailsEl.appendChild(pl);
    }
    return pl;
  };

  /* race-control strip state — declared early for the feed path */
  let lastRCtxt = "—", otkT = null;

  /* ── data source: during a live session the official F1 feed is strictly
     better (free + push deltas). OpenF1 still owns demo replay and
     post-session GPS fitting — and is anon-gated while a session runs. ── */
  let session = null, gated = false;
  if (!demo && await startFeed()) return;

  /* ── resolve session ── */
  if (demo) {
    try { session = (await jget(`sessions?session_key=${enc(demo)}`))[0]; }
    catch (e) { gated ||= !!e.gated; }
  } else {
    for (let tries = 0; tries < 60 && !session; tries++) {
      try {
        const ss = await jget(`sessions?year=${race.season}`);
        session = ss.filter((s) => s.session_name === "Race" && !s.is_cancelled)
          .sort((a, b) =>
            Math.abs(Date.parse(a.date_start) - race.at) -
            Math.abs(Date.parse(b.date_start) - race.at))[0];
        if (session && Math.abs(Date.parse(session.date_start) - race.at) > 3 * 36e5)
          session = null;
      } catch (e) { gated ||= !!e.gated; }
      if (!session) await sleep(20e3);
    }
  }
  if (!session) {
    $("#track-caption").textContent = gated
      ? "LIVE FEED LOCKED — OPENF1 REQUIRES A SPONSOR ACCOUNT"
      : "TELEMETRY SESSION NOT FOUND";
    return;
  }

  const SK = session.session_key, MK = session.meeting_key;
  const sessEnd = Date.parse(session.date_end) + 36e5; /* tolerate overruns */

  /* ── demo replay clock ── */
  let cursor = demo ? Date.parse(session.date_end) - 140e3 : null;
  const upto = () => demo ? `&date<=${enc(new Date(cursor).toISOString())}` : "";
  if (demo) {
    $("#eyebrow").textContent =
      `REPLAY · ${(session.session_name || "").toUpperCase()} ${(session.circuit_short_name || "").toUpperCase()}`;
    setInterval(() => { cursor += 300; }, 300);
  }

  /* ── drivers ── */
  for (let i = 0; i < 10 && !drivers.size; i++) {
    try {
      for (const d of await jget(`drivers?session_key=${SK}`))
        drivers.set(d.driver_number, {
          tla: d.name_acronym || `#${d.driver_number}`,
          team: d.team_name, col: "#" + (d.team_colour || "8a8f98"),
          name: d.broadcast_name, pic: d.headshot_url,
        });
    } catch { /* retry */ }
    if (!drivers.size) await sleep(4000);
  }

  $("#tower-wrap").hidden = false;
  $("#telem").hidden = false;
  $("#rc").hidden = false;
  $("#track-caption").textContent = "TELEMETRY SYNCING…";

  if (demo) { /* bound first dense feeds to replay cursor */
    const c0 = new Date(cursor - 2000).toISOString();
    last.loc = c0; last.car = c0;
  }

  /* starting grid — "positions gained" baseline (race only;
     grid rows are tagged with the Qualifying session that set them) */
  if (session.session_name === "Race") {
    try {
      const q = (await jget(`sessions?meeting_key=${MK}`))
        .find((s) => s.session_name === "Qualifying" && !s.is_cancelled);
      if (q)
        for (const g of await jget(`starting_grid?meeting_key=${MK}`))
          if (g.session_key === q.session_key)
            grid.set(g.driver_number, g.position);
    } catch { /* no grid — delta falls back to lap-1 order */ }
  }

  let fitting = false;
  const bootstrapFit = async () => {
    if (fitting || !trackPts) return;
    fitting = true;
    try {
      const ss = (await jget(`sessions?meeting_key=${MK}`))
        .filter((s) => !s.is_cancelled && (demo || s.session_key !== SK))
        .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
      for (const s of ss.slice(0, 4)) {
        const dur = Date.parse(s.date_end) - Date.parse(s.date_start);
        for (const at of [0.3, 0.55]) {
          const t0 = Date.parse(s.date_start) + dur * at;
          const L = await jget(
            `location?session_key=${s.session_key}&date>=${enc(new Date(t0).toISOString())}` +
            `&date<=${enc(new Date(t0 + 150e3).toISOString())}`);
          const pts = dedupe(
            L.filter((p) => (p.x || p.y) && isFinite(p.x) && isFinite(p.y))
             .map((p) => [p.x, p.y]));
          if (pts.length < 40) continue;
          const res = fitXF(pts, trackPts);
          if (res) {
            xf = res;
            $("#track-caption").textContent = "LIVE TRACK — REAL POSITIONS";
            return;
          }
        }
      }
      /* fallback: fit against positions streaming in right now */
      const live = dedupe(liveCloud);
      if (live.length >= 40) {
        const res = fitXF(live, trackPts);
        if (res) {
          xf = res;
          $("#track-caption").textContent = "LIVE TRACK — REAL POSITIONS";
          return;
        }
      }
      $("#track-caption").textContent = "LIVE TRACK — ORDER RIBBON";
    } catch { /* retry later */ }
    fitting = false;
  };
  if (trackPts) {
    bootstrapFit();
    setInterval(() => { if (!xf) bootstrapFit(); }, 120e3);
  }

  function renderTower() {
    if (!pos.size) return;
    const order = [...pos.entries()].sort((a, b) => a[1] - b[1]);
    const tops = new Map([...tower.children].map((li) => [li, li.offsetTop]));
    for (const [num, p] of order) {
      const li = rowFor(num);
      const iv = ints.get(num) || {};
      const st = stints.get(num);
      li.querySelector(".pos").textContent = p;
      li.setAttribute("aria-label", `P${p} ${(drivers.get(num) || {}).tla || num} — select telemetry`);
      li.querySelector(".gap").innerHTML = fmtGap(iv.gap_to_leader, p) +
        (p > 1 && iv.interval != null
          ? `<span class="iv">${fmtNum(iv.interval)}</span>` : "");
      li.classList.toggle("battle", p > 1 && iv.interval != null && +iv.interval < 1);
      li.querySelector(".fl").hidden = num !== flNum;
      const t = TYRE[st?.compound] || ["?", "#555"];
      const tyreEl = li.querySelector(".tyre");
      tyreEl.textContent = t[0];
      tyreEl.style.background = t[1];
      const pc = pits.get(num)?.c || 0;
      li.querySelector(".pits").textContent = pc ? `PIT ${pc}` : "";
      li.classList.toggle("sel", num === sel);
      li.classList.toggle("ret", retired.has(num));
      /* positions gained/lost vs starting grid (fallback: vs first order seen) */
      const dEl = li.querySelector(".delta");
      const base = grid.size ? grid.get(num) : prevPos.get(num);
      if (base != null && base !== p) {
        const up = p < base; /* lower position number = gained */
        dEl.textContent = `${up ? "▲" : "▼"}${Math.abs(p - base)}`;
        dEl.className = `delta ${up ? "up" : "down"}`;
        if (!grid.size) {
          void dEl.offsetWidth; /* restart fade animation */
          dEl.classList.add("fade");
        }
      }
      tower.appendChild(li); /* re-append = reorder */
    }
    for (const [num, p] of order) prevPos.set(num, p);
    for (const li of tower.children) {
      const dy = (tops.get(li) ?? li.offsetTop) - li.offsetTop;
      if (dy) li.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    if (!sel) sel = order[0][0], renderSel();
  }
  function renderSel() {
    const d = drivers.get(sel);
    if (d) $("#t-driver").textContent = `${d.name || d.tla} — ${d.team}`.toUpperCase();
    const pic = $("#t-pic");
    if (d?.pic) { pic.src = d.pic; pic.alt = d.tla || ""; pic.hidden = false; }
    else pic.hidden = true;
    for (const li of tower.children) li.classList.toggle("sel", +li.dataset.n === sel);
    renderDots(); renderLap(); renderRadio(); loadHist();
  }

  function renderDots() {
    const order = [...pos.entries()].sort((a, b) => a[1] - b[1]);
    const p1 = order[0]?.[0];
    let leaderPt = null;
    for (const p of loc.values()) {
      if (!(p.x || p.y)) continue;
      const g = carFor(p.driver_number);
      g.style.opacity = 1;
      let pt, real = !!xf;
      if (xf) pt = xf(p.x, p.y);
      else if (pathEl) {
        /* segment-fraction placement when the free feed supplies it —
           real sector progress, else fall back to the order ribbon */
        const f = est.get(p.driver_number) ?? segFrac.get(p.driver_number);
        const i = (pos.get(p.driver_number) || 20) - 1;
        const at = f != null ? f : Math.min(0.97, Math.max(0.03, 1 - i * 0.045));
        const q = pathEl.getPointAtLength(at * pathLen);
        pt = [q.x, q.y];
        real = f != null;
      } else continue;
      g.style.transform = `translate(${pt[0]}px,${pt[1]}px)`;
      g.classList.toggle("p1", p.driver_number === p1);
      g.classList.toggle("dim", p.driver_number !== sel && p.driver_number !== p1);
      g.querySelector("circle").setAttribute("r",
        p.driver_number === p1 ? 1.9 : p.driver_number === sel ? 1.7 : 1.35);
      /* trails only on real motion — ribbon slots are ordering, not driving */
      if (real) {
        const tr = trails.get(p.driver_number) || [];
        const last = tr[tr.length - 1];
        /* a long jump is a correction, not a drive — cut the trail */
        if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 6)
          tr.length = 0;
        const tail = tr[tr.length - 1];
        if (!tail || Math.hypot(pt[0] - tail[0], pt[1] - tail[1]) > 0.35) {
          tr.push(pt); if (tr.length > 14) tr.shift();
        }
        trails.set(p.driver_number, tr);
        const pl = trailFor(p.driver_number);
        pl.setAttribute("points", tr.map((q) => q.join(",")).join(" "));
        pl.setAttribute("stroke-width", p.driver_number === sel ? 0.9 : 0.55);
        pl.setAttribute("opacity", p.driver_number === p1 ? 0.85 : 0.5);
      }
      if (p.driver_number === p1) leaderPt = pt;
    }
    const ping = $("#ping");
    if (leaderPt) {
      ping.setAttribute("cx", leaderPt[0]);
      ping.setAttribute("cy", leaderPt[1]);
    }
    /* hide cars (and trails) with stale/no data */
    for (const g of cars.children) {
      const stale = !loc.has(+g.dataset.n);
      if (stale) g.style.opacity = 0;
      const pl = trailsEl.querySelector(`polyline[data-n="${g.dataset.n}"]`);
      if (pl) pl.style.opacity = stale ? 0 : "";
    }
  }

  /* ── telemetry card ── */
  function renderCar(e) {
    if (!e) return;
    $("#t-speed").textContent = e.speed ?? "—";
    $("#t-gear").textContent = e.n_gear > 0 ? e.n_gear : "N";
    const drs = DRS_LABEL(e.drs);
    const drsEl = $("#t-drs").parentElement;
    $("#t-drs").textContent = drs;
    drsEl.classList.toggle("open", drs === "OPEN");
    $("#t-rpm").style.width = `${Math.min(100, ((e.rpm || 0) / 12000) * 100)}%`;
    $("#t-thr").style.width = `${e.throttle || 0}%`;
    $("#t-brk").style.width = `${e.brake || 0}%`;
  }

  function renderLap() {
    const L = lastLap.get(sel);
    $("#t-lap").innerHTML = L?.lap_duration
      ? `LAST LAP <b>${L.lap_duration.toFixed(3)}</b>` : "LAST LAP —";
    /* sector chips: colour = best mini-sector flag
       (2048 slower / 2049 personal best / 2051 overall best) */
    for (let i = 1; i <= 3; i++) {
      const el = $(`#t-s${i}`), dur = L?.[`duration_sector_${i}`];
      const bs = bestSec.get(sel)?.[i - 1];
      el.innerHTML = `S${i} ${dur ? dur.toFixed(3) : "—"}` +
        (bs?.pos != null && bs.pos <= 3 ? `<em>P${bs.pos}</em>` : "");
      const sg = L?.[`segments_sector_${i}`] || [];
      el.className = "sec" + (sg.includes(2051) ? " ob"
        : sg.includes(2049) ? " pb" : sg.includes(2048) ? " sl" : "");
    }
    const st = stints.get(sel);
    const t = TYRE[st?.compound];
    /* feed stints carry stint-lap count directly; openf1 computes it */
    const tyreAge = st?.total_laps ??
      Math.max(0, maxLap - (st?.lap_start || 1) + 1 + (st?.tyre_age_at_start || 0));
    $("#t-tyre").innerHTML = t
      ? `TYRE <span class="tyre-dot" style="background:${t[1]}">${t[0]}</span>` +
        `<b>${tyreAge} LAPS${st?.fresh === true ? " ·N" : st?.fresh === false ? " ·U" : ""}</b>`
      : "";
    const pk = pits.get(sel);
    $("#t-pits").innerHTML = pk?.c
      ? `PITS <b>${pk.c}</b>` +
        (pk.last?.stop_duration
          ? ` · <b>${pk.last.stop_duration.toFixed(1)}S</b>` : "")
      : "";
    const ts = topSpd.get(sel);
    $("#t-top").innerHTML = ts ? `TOP <b>${Math.round(ts)}</b>` : "";
    const tp = traps.get(sel);
    $("#t-traps").innerHTML = tp
      ? "SPD " + ["I1", "I2", "FL", "ST"].map((k) =>
          `${k} <b>${tp[k]?.Value || "—"}</b>`).join(" ")
      : "";
    const pb = pbest.get(sel);
    $("#t-pb").innerHTML = pb ? `PB <b>${pb.t}</b>${pb.pos ? ` · P${pb.pos}` : ""}` : "";
    const pt = pitTime.get(sel);
    $("#t-pitt").innerHTML = pt ? `LANE <b>${pt.toFixed(1)}S</b>` : "";
    drawSpark();
    const total = session.session_name === "Race"
      ? (totalLaps || TOTAL_LAPS[race.circuitId]) : 0;
    const left = raceLeftAt
      ? ` · ${Math.max(0, Math.ceil((raceLeft - performance.now() + raceLeftAt) / 60000))} MIN` : "";
    $("#lap-counter").textContent =
      (total ? `LAP ${maxLap} / ${total}` : `LAP ${maxLap}`) + left;
    const age = lapStartUtc ? Math.max(0, Date.now() - lapStartUtc) : 0;
    $("#lap-age").textContent = age
      ? `+${Math.floor(age / 60000)}:${String(Math.floor(age / 1000) % 60).padStart(2, "0")}` : "";
    const ds = $("#drs-state");
    ds.textContent = drsState ? `DRS ${drsState}` : "";
    ds.className = drsState === "ON" ? "on" : "";
    $("#grip").textContent = lowGrip;
    document.title = `LAP ${maxLap} · ${race.name}`;
  }

  /* positions-over-laps chart — LapSeries lines + flag-period bands */
  function renderChart() {
    const cv = $("#pos-chart"), ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    if (lapSeries.size < 2 || maxLap < 2) { $("#chart-panel").hidden = true; return; }
    $("#chart-panel").hidden = false;
    ctx.clearRect(0, 0, W, H);
    const nLap = Math.max(...[...lapSeries.values()].map((a) => a.length), 1);
    const maxP = Math.max(20, ...[...lapSeries.values()].flat());
    const X = (l) => 26 + (l / Math.max(1, nLap - 1)) * (W - 36);
    const Y = (p) => 10 + ((p - 1) / (maxP - 1)) * (H - 34);
    const lapOf = (utc) =>
      lapStarts.reduce((a, u, j) => (u <= utc ? j : a), 0);
    /* flag periods tint the background (StatusSeries: red/sc/vsc/yellow) */
    for (let i = 0; i < statusSeries.length; i++) {
      const l0 = lapOf(statusSeries[i].utc);
      const l1 = i + 1 < statusSeries.length
        ? lapOf(statusSeries[i + 1].utc) : nLap;
      const col = /red/i.test(statusSeries[i].status) ? "rgba(255,26,16,.13)"
        : /vsc|safety/i.test(statusSeries[i].status) ? "rgba(255,180,0,.09)"
        : /yellow/i.test(statusSeries[i].status) ? "rgba(255,209,47,.09)" : null;
      if (col) { ctx.fillStyle = col; ctx.fillRect(X(l0), 0, X(l1) - X(l0), H); }
    }
    ctx.strokeStyle = "rgba(255,255,255,.05)";
    ctx.fillStyle = "rgba(255,255,255,.4)";
    ctx.font = "8px monospace"; ctx.textAlign = "right";
    for (let p = 1; p <= maxP; p += maxP > 21 ? 7 : 5) {
      ctx.beginPath(); ctx.moveTo(26, Y(p)); ctx.lineTo(W - 8, Y(p)); ctx.stroke();
      ctx.fillText(`P${p}`, 22, Y(p) + 3);
    }
    for (const [n, arr] of lapSeries) {
      ctx.strokeStyle = (drivers.get(n) || {}).col || "#888";
      ctx.lineWidth = n === sel ? 2.4 : 1;
      ctx.globalAlpha = sel && n !== sel ? 0.3 : 0.8;
      ctx.beginPath();
      arr.forEach((p, l) => {
        if (!p) return;
        l ? ctx.lineTo(X(l), Y(p)) : ctx.moveTo(X(l), Y(p));
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* mini-sector activity arcs — field-aggregated flag colour per segment */
  function buildSecArcs(n) {
    const g = $("#seclines"); g.innerHTML = ""; secArcs = [];
    for (let i = 0; i < n; i++) {
      const p = document.createElementNS(NS, "path");
      let d = "";
      for (let k = 0; k <= 6; k++) {
        const q = pathEl.getPointAtLength(((i + (k / 6) * 0.82) / n) * pathLen);
        d += (k ? "L" : "M") + q.x.toFixed(1) + " " + q.y.toFixed(1);
      }
      p.setAttribute("d", d); p.setAttribute("class", "secarc");
      g.appendChild(p); secArcs.push(p);
    }
  }
  function renderSectors() {
    if (!pathEl) return;
    const agg = []; let n = 0;
    for (const L of lastLap.values()) {
      const segs = [...(L.segments_sector_1 || []),
                    ...(L.segments_sector_2 || []),
                    ...(L.segments_sector_3 || [])];
      if (segs.length > n) n = segs.length;
      segs.forEach((s, i) => { agg[i] = Math.max(agg[i] || 0, s || 0); });
    }
    if (!n) return;
    if (!secArcs || secArcs.length !== n) buildSecArcs(n);
    for (let i = 0; i < n; i++) {
      const s = agg[i];
      secArcs[i].setAttribute("stroke",
        s === 2051 ? "#b45cff" : s === 2049 ? "#35e06c"
        : s === 2048 ? "rgba(255,209,47,.7)" : "rgba(255,255,255,.07)");
    }
  }

  /* corner numbers + marshal-sector ticks from the multiviewer pack —
     .length is arc position in decimetres; convert to path fractions */
  function drawMapLabels() {
    if (!circuitData || !pathEl) return;
    const secs = circuitData.marshalSectors || [];
    const corners = circuitData.corners || [];
    const g = $("#corners");
    g.innerHTML = "";
    if (secs.length >= 2) {
      const lens = secs.map((s) => s.length).sort((a, b) => a - b);
      const gaps = lens.slice(1).map((l, i) => l - lens[i]).sort((a, b) => a - b);
      const total = lens[lens.length - 1] + (gaps[gaps.length >> 1] || 4000);
      const frac = (l) => ((l % total) / total) * pathLen;
      for (const s of secs) {
        const q = pathEl.getPointAtLength(frac(s.length));
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", q.x); c.setAttribute("cy", q.y);
        c.setAttribute("r", 0.5); c.setAttribute("class", "mtick");
        g.appendChild(c);
      }
      for (const c of [...corners].sort((a, b) => a.number - b.number)) {
        const q = pathEl.getPointAtLength(frac(c.length));
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", q.x + 1.2); t.setAttribute("y", q.y - 1.2);
        t.setAttribute("class", "corner-txt");
        t.textContent = c.number;
        g.appendChild(t);
      }
    }
  }

  /* lap-time trace for the selected driver */
  function drawSpark() {
    const cv = $("#t-spark"), ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const hist = (lapHist.get(sel) || []).filter((l) => l.t);
    if (hist.length < 2) return;
    const ts = hist.map((l) => l.t);
    const lo = Math.min(...ts), hi = Math.max(...ts), sp = Math.max(1, hi - lo);
    ctx.strokeStyle = "rgba(255, 180, 0, 0.85)"; ctx.lineWidth = 1.4;
    ctx.beginPath();
    hist.forEach((l, i) => {
      const x = (i / (hist.length - 1)) * (W - 5) + 2;
      const y = H - 3 - ((l.t - lo) / sp) * (H - 7);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      if (sel === flNum && l.t === fl.t) {
        ctx.fillStyle = "#b45cff"; ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    });
    ctx.stroke();
  }

  /* full lap history on driver select (+ refreshes piggyback the laps loop) */
  let histReq = 0;
  async function loadHist() {
    if (feedOn || !sel) return; /* feed mode fills lapHist from deltas */
    const n = sel, tag = ++histReq;
    try {
      const rows = await jget(`laps?session_key=${SK}&driver_number=${n}` +
        `${demo ? `&date_start<=${enc(new Date(cursor).toISOString())}` : ""}`);
      if (tag !== histReq || n !== sel) return;
      lapHist.set(n, rows.filter((r) => r.lap_duration)
        .map((r) => ({ n: r.lap_number, t: r.lap_duration })));
      const sp = rows.reduce((m, r) => Math.max(m, r.st_speed || 0), 0);
      if (sp) topSpd.set(n, sp);
      renderLap();
    } catch { /* partial history is fine */ }
  }

  function renderRadio() {
    const a = $("#t-radio"), u = radios.get(sel);
    if (u) { a.href = u; a.hidden = false; } else a.hidden = true;
  }

  /* ── race control ── */
  /* overtake ticker borrows the strip for a few seconds, then hands it back */
  function flashRC(txt) {
    $("#rc-msg").textContent = txt;
    $("#rc").classList.add("otk");
    clearTimeout(otkT);
    otkT = setTimeout(() => {
      $("#rc").classList.remove("otk");
      $("#rc-msg").textContent = lastRCtxt;
    }, 5000);
  }

  function renderRC(e) {
    const rc = $("#rc");
    lastRCtxt = e.message || e.category || "—";
    clearTimeout(otkT); rc.classList.remove("otk");
    $("#rc-msg").textContent = lastRCtxt;
    const txt = `${e.flag || ""} ${e.category || ""} ${e.message || ""}`.toUpperCase();
    rc.className = "rc" + (txt.includes("CHEQUERED") ? " cheq"
      : txt.includes("RED") ? " red"
      : txt.includes("SAFETY CAR") || txt.includes("VSC") ? " sc"
      : txt.includes("YELLOW") ? " yellow"
      : txt.includes("GREEN") || txt.includes("CLEAR") ? " green" : "");
    document.body.dataset.flag = txt.includes("CHEQUERED") ? "cheq"
      : txt.includes("RED") ? "red"
      : txt.includes("SAFETY CAR") || txt.includes("VSC") ? "sc"
      : txt.includes("YELLOW") ? "yellow" : "";
    if (txt.includes("CHEQUERED") && !renderRC.cheq) {
      renderRC.cheq = true;
      const d = document.createElement("div");
      d.className = "checker"; document.body.appendChild(d);
      setTimeout(() => d.remove(), 3000);
    }
  }

  /* ── poll loops: each fetch uses delta since last event ── */
  const loop = async (ms, fn) => {
    for (;;) {
      try { await fn(); } catch (e) { console.debug("live poll:", e); }
      await sleep(ms);
    }
  };

  loop(4e3, async () => {
    for (const e of await jget(
      `position?session_key=${SK}${last.pos ? `&date>=${enc(last.pos)}` : ""}${upto()}`)) {
      pos.set(e.driver_number, e.position); last.pos = e.date;
    }
    renderTower(); renderDots();
  });

  loop(4e3, async () => {
    await sleep(2e3); /* stagger */
    for (const e of await jget(
      `intervals?session_key=${SK}${last.int ? `&date>=${enc(last.int)}` : ""}${upto()}`)) {
      ints.set(e.driver_number, e); last.int = e.date;
    }
    renderTower();
  });

  loop(1800, async () => {
    for (const e of await jget(
      `location?session_key=${SK}${last.loc ? `&date>=${enc(last.loc)}` : ""}${upto()}`)) {
      loc.set(e.driver_number, e); last.loc = e.date;
      if ((e.x || e.y) && isFinite(e.x) && isFinite(e.y) && liveCloud.length < 20000)
        liveCloud.push([e.x, e.y]);
    }
    renderDots();
  });

  loop(3e3, async () => {
    if (!sel) return;
    const rows = await jget(
      `car_data?session_key=${SK}&driver_number=${sel}` +
      `${last.car ? `&date>=${enc(last.car)}` : ""}${upto()}`);
    const e = rows[rows.length - 1];
    if (e) { last.car = e.date; renderCar(e); }
  });

  loop(9e3, async () => {
    const rows = await jget(
      `laps?session_key=${SK}&lap_number>=${Math.max(1, maxLap - 1)}` +
      `${demo ? `&date_start<=${enc(new Date(cursor).toISOString())}` : ""}`);
    for (const e of rows) {
      maxLap = Math.max(maxLap, e.lap_number || 0);
      if (e.st_speed > (topSpd.get(e.driver_number) || 0))
        topSpd.set(e.driver_number, e.st_speed);
      if (e.lap_duration) {
        const prev = lastLap.get(e.driver_number);
        if (!prev || e.lap_number >= prev.lap_number) lastLap.set(e.driver_number, e);
        if (!fl.t || e.lap_duration < fl.t) fl = { t: e.lap_duration, n: e.driver_number };
        const h = lapHist.get(e.driver_number);
        if (h && !h.some((l) => l.n === e.lap_number)) {
          h.push({ n: e.lap_number, t: e.lap_duration });
          h.sort((a, b) => a.n - b.n);
        }
      }
    }
    if (fl.n !== flNum) { flNum = fl.n; renderTower(); }
    renderLap();
  });

  loop(30e3, async () => {
    for (const e of await jget(`stints?session_key=${SK}`)) {
      const prev = stints.get(e.driver_number);
      if (!prev || e.stint_number >= prev.stint_number) stints.set(e.driver_number, e);
    }
    renderTower(); renderLap();
  });

  loop(30e3, async () => {
    const old = new Map(pits);
    pits.clear();
    for (const e of await jget(`pit?session_key=${SK}${upto()}`)) {
      const pk = pits.get(e.driver_number) || { c: 0 };
      pk.c++; pk.last = e; pits.set(e.driver_number, pk);
    }
    /* pit-lane pulse: flash the dot of whoever just boxed */
    for (const [n, pk] of pits) {
      if (pk.c > (old.get(n)?.c || 0) && pk.c > (prevPits.get(n) || 0)) {
        const circ = cars.querySelector(`g[data-n="${n}"] circle`);
        if (circ) {
          circ.classList.remove("pit");
          requestAnimationFrame(() => circ.classList.add("pit"));
          setTimeout(() => circ.classList.remove("pit"), 2600);
        }
      }
      prevPits.set(n, pk.c);
    }
    renderTower(); renderLap();
  });

  loop(10e3, async () => {
    for (const e of await jget(
      `race_control?session_key=${SK}${last.rc ? `&date>=${enc(last.rc)}` : ""}${upto()}`)) {
      last.rc = e.date; renderRC(e);
      /* flag the tower row of the driver an RC message is about */
      if (e.driver_number) {
        const li = rowFor(e.driver_number);
        li.classList.add("rc-hit");
        setTimeout(() => li.classList.remove("rc-hit"), 8000);
      }
    }
  });

  /* session weather feed — real track temp & rainfall, not the forecast */
  loop(60e3, async () => {
    await sleep(4e3); /* stagger boot requests */
    const rows = await jget(
      `weather?session_key=${SK}${last.wx ? `&date>=${enc(last.wx)}` : ""}${upto()}`);
    const w = rows[rows.length - 1];
    if (!w) return;
    last.wx = w.date;
    $("#wx").innerHTML =
      `TRACK <b>${w.track_temperature.toFixed(1)}°C</b>` +
      ` · AIR <b>${w.air_temperature.toFixed(1)}°C</b>` +
      ` · HUM <b>${Math.round(w.humidity)}%</b>` +
      (w.rainfall ? ` · <b>RAIN</b>` : "");
    document.body.dataset.wx = w.rainfall ? "61" : "0"; /* drives the rain layer */
  });

  /* official overtake detections — flash on the rc strip */
  loop(12e3, async () => {
    await sleep(6e3); /* stagger */
    for (const e of await jget(
      `overtakes?session_key=${SK}${last.otk ? `&date>=${enc(last.otk)}` : ""}${upto()}`)) {
      last.otk = e.date;
      const a = drivers.get(e.overtaking_driver_number)?.tla || e.overtaking_driver_number;
      const b = drivers.get(e.overtaken_driver_number)?.tla || e.overtaken_driver_number;
      flashRC(`OVERTAKE — ${a} ▸ ${b} FOR P${e.position}`);
    }
  });

  /* team radio: latest playable clip for the selected driver */
  loop(25e3, async () => {
    await sleep(8e3); /* stagger */
    for (const e of await jget(
      `team_radio?session_key=${SK}${last.rad ? `&date>=${enc(last.rad)}` : ""}${upto()}`)) {
      radios.set(e.driver_number, e.recording_url); last.rad = e.date;
    }
    renderRadio();
  });

  loop(45e3, async () => { /* refresh sparkline while laps accumulate */
    await sleep(11e3); /* stagger */
    loadHist();
  });

  /* ── official F1 live-timing feed (SignalR via /f1 proxy) — used when
     OpenF1 is gated. Same renderers, same state maps; GPS positions and
     car telemetry are subscription-gated, so the map shows the order
     ribbon and speed/gear stay blank. ── */
  async function startFeed() {
    let conn = null;
    for (let a = 0; a < 3 && !conn; a++) {
      try { conn = await (await import("./f1feed.js")).connect(); }
      catch { if (a < 2) await sleep(2000); }
    }
    if (!conn) return false;

    const store = {}; /* deep-merged topic trees (snapshot + deltas) */
    const deep = (t, p) => {
      for (const k in p) {
        const v = p[k];
        if (v && typeof v === "object" && t[k] && typeof t[k] === "object")
          deep(t[k], v);
        else t[k] = v;
      }
    };
    /* "1:16.256" → seconds; plain numbers pass through */
    const pf = (v) => {
      if (v == null || v === "") return null;
      const m = /^(\d+):([\d.]+)$/.exec(v);
      return m ? +m[1] * 60 + +m[2] : (+v || null);
    };

    let lastRCe = null;
    const apply = {
      DriverList() {
        for (const [num, e] of Object.entries(store.DriverList || {})) {
          if (!e.Tla) continue;
          drivers.set(+num, {
            tla: e.Tla, team: e.TeamName,
            col: "#" + (e.TeamColour || "8a8f98"),
            name: e.BroadcastName, pic: e.HeadshotUrl,
          });
        }
      },
      TimingData() {
        for (const [num, e] of Object.entries(store.TimingData?.Lines || {})) {
          const n = +num;
          if (e.Position != null) pos.set(n, +e.Position);
          loc.set(n, { driver_number: n, x: 1, y: 1 }); /* ribbon slots */
          ints.set(n, {
            gap_to_leader: e.GapToLeader ?? null,
            interval: e.IntervalToPositionAhead?.Value ?? null,
          });
          if (e.Retired || e.Stopped) retired.add(n); else retired.delete(n);
          /* pit pulse on the false→true edge of InPit */
          if (e.InPit && !wasInPit.get(n)) {
            const circ = cars.querySelector(`g[data-n="${n}"] circle`);
            if (circ) {
              circ.classList.remove("pit");
              requestAnimationFrame(() => circ.classList.add("pit"));
              setTimeout(() => circ.classList.remove("pit"), 2600);
            }
          }
          wasInPit.set(n, !!e.InPit);
          drive.set(n, { inPit: !!e.InPit, stopped: !!e.Stopped });
          const secs = Object.values(e.Sectors || {});
          const seg = (i) => secs[i]?.Segments
            ? Object.values(secs[i].Segments).map((s) => s.Status) : [];
          const lapN = e.NumberOfLaps || 0;
          if (lapN > maxLap) maxLap = lapN;
          const lapT = pf(e.LastLapTime?.Value);
          lastLap.set(n, {
            lap_duration: lapT, lap_number: lapN,
            duration_sector_1: pf(secs[0]?.Value), duration_sector_2: pf(secs[1]?.Value),
            duration_sector_3: pf(secs[2]?.Value),
            segments_sector_1: seg(0), segments_sector_2: seg(1),
            segments_sector_3: seg(2),
            st_speed: +e.Speeds?.ST?.Value || undefined,
          });
          const pk = pits.get(n) || { c: 0 };
          pk.c = e.NumberOfPitStops ?? pk.c;
          pits.set(n, pk);
          /* real position on track = share of completed mini-segments
             (~500 m granularity — no gps on the free feed) */
          let segT = 0, segD = 0;
          for (const s of secs)
            for (const x of Object.values(s?.Segments || {})) {
              segT++; if (x?.Status) segD++;
            }
          if (segT) segFrac.set(n, segD / segT);
          if (lapT) {
            const h = lapHist.get(n) || [];
            if (!h.some((l) => l.n === lapN)) h.push({ n: lapN, t: lapT });
            lapHist.set(n, h);
          }
          const bl = pf(e.BestLapTime?.Value);
          if (bl && (!fl.t || bl < fl.t)) { fl.t = bl; fl.n = n; flNum = n; }
          for (const k of Object.values(e.Speeds || {})) {
            const sp = +k?.Value;
            if (sp > (topSpd.get(n) || 0)) topSpd.set(n, sp);
          }
          if (e.Speeds) traps.set(n, e.Speeds);
        }
      },
      SessionInfo() { loadCircuit(); },
      TimingAppData() {
        for (const [num, e] of Object.entries(store.TimingAppData?.Lines || {})) {
          const st = Object.values(e.Stints || {});
          const cur = st[st.length - 1];
          if (cur?.Compound)
            stints.set(+num, { compound: cur.Compound, total_laps: cur.TotalLaps,
              fresh: cur.New === "true" || cur.New === true });
          if (e.GridPos != null) grid.set(+num, +e.GridPos);
        }
      },
      LapCount() {
        const lc = store.LapCount || {};
        if (lc.CurrentLap) maxLap = Math.max(maxLap, lc.CurrentLap);
        if (lc.TotalLaps) totalLaps = lc.TotalLaps;
      },
      LapSeries() {
        for (const [num, e] of Object.entries(store.LapSeries || {}))
          if (e.LapPosition?.length)
            lapSeries.set(+num, e.LapPosition.map((p) => +p || null));
      },
      DriverTracker() {
        /* broadcast whole-field rows — fills the gaps TimingData leaves */
        for (const e of store.DriverTracker?.Lines || []) {
          const n = +e.RacingNumber;
          if (!ints.get(n)?.gap_to_leader && e.DiffToLeader != null)
            ints.set(n, {
              gap_to_leader: e.DiffToLeader || null,
              interval: e.DiffToAhead || null,
            });
        }
      },
      WeatherDataSeries() {
        const s = store.WeatherDataSeries?.Series;
        if (!Array.isArray(s) || !s.length) return;
        const w = s[0]?.Weather;
        if (w && !wxFirst) wxFirst = w;
      },
      AudioStreams() {
        const s = (store.AudioStreams?.Streams || [])
          .find((x) => x.Uri || x.Path);
        if (!s || audioUrl) return;
        audioUrl = s.Uri ||
          `https://livetiming.formula1.com/static/${store.SessionInfo?.Path || ""}${s.Path}`;
        $("#comms").hidden = false;
      },
      TyreStintSeries() {
        /* richer stint rows than TimingAppData — New flag included */
        for (const [num, st] of Object.entries(store.TyreStintSeries || {})) {
          const v = Object.values(st || {});
          const cur = v[v.length - 1];
          if (cur?.Compound)
            stints.set(+num, {
              compound: cur.Compound, total_laps: cur.TotalLaps,
              fresh: cur.New === "true" || cur.New === true,
            });
        }
      },
      CurrentTyres() {
        for (const [num, e] of Object.entries(store.CurrentTyres?.Tyres || {})) {
          const st = stints.get(+num) || {};
          stints.set(+num, { ...st, compound: e.Compound || st.compound,
            fresh: e.New === "true" || e.New === true });
        }
      },
      PitStop() {
        /* stationary pit times when the topic exists */
        for (const [num, e] of Object.entries(store.PitStop?.PitTimes || {})) {
          const last = Array.isArray(e) ? e[e.length - 1] : e;
          const d = +last?.PitStop?.StopTime || +last?.Duration || 0;
          if (d) pitTime.set(+num, d);
        }
      },
      TimingStats() {
        for (const [num, e] of Object.entries(store.TimingStats?.Lines || {})) {
          const pb = e.PersonalBestLapTime;
          if (pb?.Value) pbest.set(+num, { t: pb.Value, pos: pb.Position });
          if (e.BestSectors)
            bestSec.set(+num, Object.values(e.BestSectors)
              .map((s) => ({ pos: s?.Position })));
        }
      },
      SessionData() {
        const ser = Object.values(store.SessionData?.Series || {});
        lapStarts.length = 0;
        for (const s of ser) if (s?.Utc) lapStarts.push(Date.parse(s.Utc));
        const last = ser[ser.length - 1];
        if (last?.Utc) lapStartUtc = Date.parse(last.Utc);
        /* flag timeline for the chart's status bands */
        statusSeries.length = 0;
        for (const s of Object.values(store.SessionData?.StatusSeries || {}))
          if (s?.Utc && s.TrackStatus)
            statusSeries.push({ utc: Date.parse(s.Utc), status: s.TrackStatus });
      },
      PitLaneTimeCollection() {
        for (const [num, e] of Object.entries(store.PitLaneTimeCollection?.PitTimes || {}))
          if (e?.Duration) pitTime.set(+num, +e.Duration);
      },
      ExtrapolatedClock() {
        /* "00:26:34" → ms */
        const m = /(\d+):(\d+):(\d+)/.exec(store.ExtrapolatedClock?.Remaining || "");
        if (m) {
          raceLeft = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
          raceLeftAt = performance.now();
        }
      },
      WeatherData() {
        const w = store.WeatherData;
        if (!w?.TrackTemp) return;
        const dt = wxFirst ? +w.TrackTemp - +wxFirst.TrackTemp : 0;
        $("#wx").innerHTML =
          `TRACK <b>${(+w.TrackTemp).toFixed(1)}°C</b>` +
          (Math.abs(dt) >= 1
            ? ` <small>${dt > 0 ? "▲" : "▼"}${Math.abs(dt).toFixed(1)}</small>` : "") +
          ` · AIR <b>${(+w.AirTemp).toFixed(1)}°C</b>` +
          ` · HUM <b>${Math.round(+w.Humidity)}%</b>` +
          (+w.Rainfall ? ` · <b>RAIN</b>` : "");
        document.body.dataset.wx = +w.Rainfall ? "61" : "0";
      },
      TrackStatus() {
        /* 1 clear · 2 yellow · 4 safety car · 5 red · 6/7 vsc */
        document.body.dataset.flag =
          { 2: "yellow", 4: "sc", 5: "red", 6: "sc", 7: "sc" }
            [store.TrackStatus?.Status] || "";
      },
      SessionStatus() {
        const s = store.SessionStatus?.Status;
        if (s === "Finished" || s === "Finalised") {
          document.body.dataset.flag = "cheq";
          if (!renderRC.cheq) {
            renderRC.cheq = true;
            const d = document.createElement("div");
            d.className = "checker"; document.body.appendChild(d);
            setTimeout(() => d.remove(), 2800);
          }
          setTimeout(finish, 2800); /* finish.done dedupes */
        }
      },
      RaceControlMessages() {
        const msgs = Object.values(store.RaceControlMessages?.Messages || {});
        /* latest DRS enable/disable across the log */
        for (const x of msgs) {
          const mm = /DRS (EN|DIS)ABLED/i.exec(x?.Message || "");
          if (mm) drsState = mm[1].toUpperCase() === "EN" ? "ON" : "OFF";
          /* track-condition flags worth a chip of their own */
          const m = (x?.Message || "").toUpperCase();
          if (m.includes("OVERTAKE ENABLED")) lowGrip = "";
          else if (m.includes("OVERTAKE DISABLED")) lowGrip = "NO OVERTAKE";
          else if (m.includes("LOW GRIP")) lowGrip = "LOW GRIP";
        }
        const e = msgs[msgs.length - 1];
        if (!e || e === lastRCe) return;
        lastRCe = e;
        renderRC({ message: e.Message, category: e.Category, flag: e.Flag });
        if (e.RacingNumber) {
          const li = rowFor(+e.RacingNumber);
          li.classList.add("rc-hit");
          setTimeout(() => li.classList.remove("rc-hit"), 8000);
        }
      },
      TeamRadio() {
        const base = "https://livetiming.formula1.com/static/" +
          (store.SessionInfo?.Path || "");
        for (const c of Object.values(store.TeamRadio?.Captures || {}))
          if (c.Path) radios.set(+c.RacingNumber, base + c.Path);
        renderRadio();
      },
    };

    /* multiviewer circuit pack — corners, marshal sectors, pit loss */
    async function loadCircuit() {
      const k = store.SessionInfo?.Meeting?.Circuit?.Key;
      const yr = +(store.SessionInfo?.StartDate || "").slice(0, 4) || race.season;
      if (!k || circuitData) return;
      try {
        const r = await fetch(
          `https://api.multiviewer.app/api/v1/circuits/${k}/${yr}`);
        if (!r.ok) return;
        circuitData = await r.json();
        const pl = +circuitData?.pitLoss?.normal;
        if (pl) $("#pit-loss").textContent = `PIT LOSS ${pl.toFixed(1)}S`;
        drawMapLabels();
      } catch { circuitData = null; }
    }

    /* podium overlay at the flag — real classification + fastest lap */
    function finish() {
      if (finish.done || !pos.size) return;
      finish.done = true;
      raceLeftAt = 0; /* kill the countdown — the flag decided the race */
      const top = [...pos.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3);
      const el = $("#finish");
      el.innerHTML = `<div class="fin-card">
        <div class="fin-flag"><i></i>CHEQUERED FLAG<i></i></div>
        <div class="fin-race">${race.name} · LAP ${maxLap}</div>
        ${top.map(([n], i) => {
          const d = drivers.get(n) || {};
          const g = ints.get(n)?.gap_to_leader;
          return `<div class="fin-row p${i}" data-n="${n}">
            <b class="fin-pos">${i + 1}</b>
            ${d.pic ? `<img src="${d.pic}" alt="">` : ""}
            <span class="fin-tla" style="color:${d.col}">${d.tla}</span>
            <span class="fin-name">${d.name || ""}</span>
            <span class="fin-team">${d.team || ""}</span>
            <b class="fin-gap">${i ? (g ?? "—") : "WINNER"}</b>
          </div>`;
        }).join("")}
        ${flNum && fl.t ? `<div class="fin-fl">FASTEST LAP · ` +
          `${(drivers.get(flNum) || {}).tla || flNum} — ${fl.t.toFixed(3)}</div>` : ""}
        <div class="fin-hint">TAP TO DISMISS</div>
      </div>`;
      el.hidden = false;
      el.onclick = () => { el.hidden = true; };
      /* official points on the podium rows — openf1 if it answers post-flag */
      (async () => {
        try {
          const si = store.SessionInfo || {};
          const yr = +(si.StartDate || "").slice(0, 4) || race.season;
          const ck = si.Meeting?.Circuit?.Key;
          if (!ck) return;
          const ss = await jget(
            `sessions?year=${yr}&session_name=Race&circuit_key=${ck}`);
          const sk = ss?.[ss.length - 1]?.session_key;
          if (!sk) return;
          const pts = new Map((await jget(
            `session_result?session_key=${sk}`))
            .map((r) => [r.driver_number, r.points]));
          el.querySelectorAll(".fin-row").forEach((row) => {
            const p = pts.get(+row.dataset.n);
            if (p != null) {
              const g = row.querySelector(".fin-gap");
              g.textContent = `${g.textContent} · +${p} PTS`;
            }
          });
        } catch { /* gated or absent — podium is complete without it */ }
      })();
    }

    const ready = new Promise((res) => {
      const to = setTimeout(() => res(false), 12e3);
      conn.onSnapshot = (r) => {
        for (const k in r) deep(store[k] ||= {}, r[k]);
        /* the service also replays the LAST session — only engage when
           it actually matches today (or is still running) */
        const si = store.SessionInfo || {};
        /* EndDate is track-local; a wide window absorbs the tz skew and
           still rejects yesterday's replayed state */
        const live = /started|green/i.test(store.SessionStatus?.Status || "") ||
          !si.EndDate ||
          Date.now() < Date.parse(si.EndDate.replace(" ", "T")) + 8 * 36e5;
        if (!live) return res(false);
        for (const k in apply)
          try { apply[k](); } catch (e) { console.warn("feed apply", k, e); }
        clearTimeout(to); res(true);
      };
    });
    conn.onFeed = (tp, patch) => {
      deep(store[tp] ||= {}, patch);
      try { apply[tp]?.(); } catch (e) { console.warn("feed apply", tp, e); }
    };

    /* panels open only once a live snapshot is confirmed */
    if (!await ready) { conn.close(); return false; }
    feedOn = true;
    session = { session_name: "Race" };
    $("#tower-wrap").hidden = false;
    $("#telem").hidden = false;
    $("#telem").classList.add("timing"); /* car channels are sub-gated */
    $("#rc").hidden = false;
    $("#track-caption").textContent = "LIVE TIMING — SECTOR POSITIONS";
    if (location.search.includes("finish")) setTimeout(finish, 1500);
    /* COMMS — the free F1 radio commentary HLS stream */
    const comms = $("#comms");
    let commAudio = null, commHls = null;
    comms.addEventListener("click", async () => {
      if (!audioUrl) return;
      if (commAudio && !commAudio.paused) {
        commAudio.pause();
        comms.classList.remove("on"); comms.textContent = "COMMS";
        return;
      }
      commAudio ??= new Audio();
      try {
        if (commAudio.canPlayType("application/vnd.apple.mpegurl"))
          commAudio.src = audioUrl;
        else {
          const { default: Hls } = await import(
            "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js");
          commHls ??= (() => {
            const h = new Hls(); h.attachMedia(commAudio); return h;
          })();
          commHls.loadSource(audioUrl);
        }
        await commAudio.play();
        comms.classList.add("on"); comms.textContent = "MUTE";
      } catch { comms.textContent = "COMMS"; }
    });
    loadCircuit();
    setInterval(() => {
      renderTower(); renderDots(); renderLap(); renderChart(); renderSectors();
    }, 900);
    /* car motion is extrapolated between segment anchors: drive at
       ~1/recent-lap pace, pull toward truth (fast on big corrections —
       pit/stall/resync — soft otherwise). Lap wrap is smooth because the
       anchor delta is circular. */
    let rafT = performance.now();
    if (!RM) cars.classList.add("live");
    if (!RM) (function step(now) {
      const dt = Math.min(1, (now - rafT) / 1000); rafT = now;
      for (const n of loc.keys()) {
        const truth = segFrac.get(n);
        if (truth == null) continue;
        let e = est.get(n);
        if (e == null) e = truth;
        else {
          const dr = drive.get(n) || {};
          if (!dr.stopped && !retired.has(n))
            e += (dr.inPit ? 0.3 : 1) / (lastLap.get(n)?.lap_duration || 75) * dt;
          /* corrections are velocity-capped — the car glides toward the
             anchor (4%/lap per sec) instead of snapping on segment ticks;
             only big resyncs (pit/rejoin) get a faster catch-up */
          let d = truth - e; d -= Math.round(d);
          const vmax = Math.abs(d) > 0.06 ? 0.15 : 0.04;
          e += Math.sign(d) * Math.min(Math.abs(d), vmax * dt);
        }
        est.set(n, e - Math.floor(e));
      }
      renderDots();
      requestAnimationFrame(step);
    })(rafT);
    return true;
  }

  /* demo: loop the replay window */
  if (demo) setInterval(() => {
    if (cursor > sessEnd) {
      cursor = Date.parse(session.date_start) + 90e3;
      for (const k of Object.keys(last)) last[k] = "";
      for (const m of [pos, ints, stints, pits, lastLap, loc, trails, prevPos,
                       prevPits, lapHist, topSpd, radios, segFrac, est,
                       drive, traps, pbest, pitTime]) m.clear();
      cars.innerHTML = ""; trailsEl.innerHTML = "";
      maxLap = 0; flNum = 0; fl.t = 0; fl.n = 0; renderRC.cheq = false;
      document.body.dataset.flag = "";
    }
  }, 2000);
}
