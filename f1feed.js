/* f1feed.js — official F1 live-timing SignalR Core feed via the same-origin
   /f1/* proxy in server.js. Anonymous topics stream the whole timing tower,
   sectors, race control, weather and radio links. Position.z / CarData.z are
   F1-TV-subscription gated and intentionally not requested. */
"use strict";

const RS = "\x1e";
const TOPICS = [
  "Heartbeat", "ExtrapolatedClock", "TopThree", "TimingStats", "TimingAppData",
  "TimingData", "DriverList", "RaceControlMessages", "SessionInfo",
  "SessionData", "SessionStatus", "TrackStatus", "WeatherData", "LapCount",
  "TeamRadio", "PitLaneTimeCollection",
  /* free extras — absent topics are silently ignored by the server */
  "LapSeries", "DriverTracker", "WeatherDataSeries", "AudioStreams",
  "ContentStreams", "ArchiveStatus", "TyreStintSeries", "CurrentTyres",
  "OvertakeSeries", "PitStop", "TimingDataF1", "DriverScore", "TlaRcm",
  "SPFeed",
];

export async function connect() {
  const neg = await fetch("/f1/signalrcore/negotiate?negotiateVersion=1",
    { method: "POST" });
  if (!neg.ok) throw new Error("neg " + neg.status);
  const { connectionToken } = await neg.json();
  const id = encodeURIComponent(connectionToken);

  const send = async (body) => {
    const r = await fetch(`/f1/signalrcore?id=${id}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body,
      signal: AbortSignal.timeout(10e3),
    });
    const t = await r.text();
    return r.status + " " + t.slice(0, 60);
  };

  const es = new EventSource(`/f1/signalrcore?id=${id}`);
  const conn = { onSnapshot: null, onFeed: null, close: () => es.close() };

  /* fires on first connect AND every auto-reconnect → always re-subscribe */
  es.onopen = async () => {
    try {
      await send('{"protocol":"json","version":1}' + RS);
      await send(JSON.stringify({
        type: 1, target: "Subscribe", invocationId: "0", arguments: [TOPICS],
      }) + RS);
    } catch { /* stream retry follows on its own */ }
  };

  es.onmessage = (m) => {
    /* the record separator arrives inside the data payload */
    let j; try { j = JSON.parse(m.data.replace(/\x1e+$/, "")); }
    catch { return; }
    if (j.target === "feed") conn.onFeed?.(j.arguments[0], j.arguments[1]);
    else if (j.type === 3 && j.result) conn.onSnapshot?.(j.result);
  };
  return conn;
}
