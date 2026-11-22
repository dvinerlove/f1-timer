# LIGHTS OUT — F1 Race Countdown & Live Timing

A zero-dependency web app that counts down to the next Formula 1 Grand Prix — then switches to a full live-timing view when the race starts.

**[▶ Open the countdown](https://dvinerlove.github.io/f1-timer/)** — static mirror on GitHub Pages (countdown, schedule, circuit map, weather all work; the official-timing feed needs the local proxy below).

![License](https://img.shields.io/badge/license-MIT-green)

## Features

**Between races**
- Millisecond countdown to lights out, race name, circuit, locality
- Full weekend schedule (FP1–FP3, sprint, quali, race) in your local time
- Circuit outline map drawn from real GeoJSON track data
- Current track weather and local track clock

**During a session**
- Live timing tower — positions, gaps, sectors, tyre stints, pit stops
- Position-flow chart for the whole race
- Live car dots on the circuit map (OpenF1 location feed, projected onto the track outline)
- Per-driver telemetry: speed, gear, DRS, RPM, throttle/brake bars, sector times
- Race Control messages ticker, team radio links, DRS/grip state
- Session results after the flag

## Run it

```bash
node server.js    # → http://localhost:8420
```

Node 18+ only — no npm install, no dependencies.

Replay a past session instead of waiting for a live one:

```
http://localhost:8420/?demo=<openf1_session_key>
```

## Why the server exists

The front end is plain HTML/CSS/JS, but two things need a backend:

1. `livetiming.formula1.com` (the official F1 SignalR feed) is CORS-blocked and needs ALB cookie stickiness — `server.js` proxies `/f1/*` with a cookie jar.
2. Static files need serving anyway.

`live.js` pulls the open telemetry feeds (location, car data, timing, radio) from [OpenF1](https://openf1.org); during a live session OpenF1 gates the API behind a (free) sponsor account — drop `f1user`/`f1pass` into localStorage and it authenticates itself.

## Test

```bash
node fit-test.js   # fits a real OpenF1 session onto the Interlagos outline; exits non-zero on regression
```

## Data sources

- Schedule/results: [jolpica](https://api.jolpi.ca) (Ergast-compatible)
- Circuit geometry: [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) GeoJSON
- Track weather: [open-meteo](https://open-meteo.com)
- Live timing proxy target: livetiming.formula1.com
- Telemetry/replay: [OpenF1](https://openf1.org)

## License

MIT
