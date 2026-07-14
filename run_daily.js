// run_daily.js — Gresham Index daily publisher (GitHub Actions edition)
// Fetches CoinMetrics Community API, computes the index with the frozen
// v1.0.1 engine, and writes the public JSON files into docs/ (GitHub Pages).
// Policies encoded here:
//   - record.json is APPEND-ONLY: existing entries are never modified.
//   - data older than 48h  ->  "stale": true, published openly.
//   - attribution to CoinMetrics Community (CC BY-NC 4.0) in every file.
"use strict";

const fs = require("fs");
const path = require("path");
const { greshamIndex } = require("./gresham_engine.js");

const OUT = path.join(__dirname, "docs");
const MS_DAY = 86400000;

const CM_URL = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
  + "?assets=btc&metrics=PriceUSD,CapMVRVCur,CapMrktCurUSD,IssTotUSD"
  + "&frequency=1d&page_size=10000&start_time=2010-07-01";

const TEST_VECTORS = [
  ["2014-06-01",0.2586],["2015-01-14",0.0280],["2016-06-01",0.4536],["2017-07-25",0.7866],
  ["2017-12-16",0.8886],["2018-12-15",0.0702],["2019-06-26",0.6877],["2020-03-16",0.1750],
  ["2020-12-01",0.7089],["2021-04-13",0.9012],["2021-11-08",0.7897],["2022-06-18",0.0962],
  ["2022-11-21",0.0613],["2023-10-01",0.2622],["2024-03-13",0.8142],["2024-11-01",0.5830],
  ["2025-10-06",0.7290],["2026-01-15",0.3943],["2026-05-23",0.3160],
];

function zoneOf(r) {
  if (r < 0.15) return { zone: "stack_3x", label: "Stack 3\u00d7",  action: "Buy 3\u00d7 your base + deploy 15%/wk of reserve" };
  if (r < 0.30) return { zone: "stack_2x", label: "Stack 2\u00d7",  action: "Buy 2\u00d7 your base + deploy 8%/wk of reserve" };
  if (r < 0.50) return { zone: "normal",   label: "Normal 1\u00d7", action: "Buy 1\u00d7 \u2014 business as usual" };
  if (r < 0.65) return { zone: "slow",     label: "Slow 0.5\u00d7", action: "Buy 0.5\u00d7 \u2014 let cash build" };
  if (r < 0.75) return { zone: "hold",     label: "Hold",           action: "Grey zone \u2014 no buys, no sells" };
  if (r < 0.85) return { zone: "sell_1_5", label: "Sell 1.5%/wk",   action: "Sell 1.5% of your stack this week" };
  return          { zone: "sell_4",   label: "Sell 4%/wk",     action: "Sell 4% of your stack this week" };
}

async function fetchAllRows() {
  const rows = [];
  let url = CM_URL, pages = 0;
  while (url && pages < 20) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`CoinMetrics HTTP ${res.status}`);
    const j = await res.json();
    for (const d of (j.data || [])) {
      const price = +d.PriceUSD;
      if (!Number.isFinite(price) || price <= 0) continue;
      rows.push({ date: d.time.slice(0, 10), PriceUSD: price,
                  CapMVRVCur: d.CapMVRVCur, CapMrktCurUSD: d.CapMrktCurUSD, IssTotUSD: d.IssTotUSD });
    }
    url = j.next_page_url || null;
    pages++;
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, file), "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(data, null, 1));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const computedAt = new Date().toISOString();
  const ATTR = "Data: CoinMetrics Community (CC BY-NC 4.0)";

  const rows = await fetchAllRows();
  if (rows.length < 3000) throw new Error(`suspiciously few rows: ${rows.length}`);
  const { dates, price, risk } = greshamIndex(rows);

  let li = risk.length - 1;
  while (li >= 0 && Number.isNaN(risk[li])) li--;
  if (li < 0) throw new Error("no valid risk value computed");
  const dataThrough = dates[li];
  const stale = (Date.now() - Date.parse(dataThrough + "T00:00:00Z")) / MS_DAY > 2;
  const r = Math.round(risk[li] * 10000) / 10000;
  const z = zoneOf(r);

  // latest.json
  writeJSON("latest.json", {
    index: "Gresham Index", version: "1.0.1",
    value: r, zone: z.zone, zone_label: z.label, action: z.action,
    price_usd: Math.round(price[li] * 100) / 100,
    data_through: dataThrough, computed_at: computedAt, stale,
    attribution: ATTR,
  });

  // history.json (full recomputed series; labeled reconstruction + live)
  const series = [];
  for (let i = 0; i < risk.length; i++) {
    if (!Number.isNaN(risk[i]))
      series.push([dates[i], Math.round(risk[i] * 10000) / 10000, Math.round(price[i] * 100) / 100]);
  }
  const prevHist = readJSON("history.json", null);
  const publishedSince = (prevHist && prevHist.published_since) || dataThrough;
  writeJSON("history.json", {
    published_since: publishedSince,
    note: "Entries before published_since are backtest reconstruction under frozen v1.0.1 rules; entries from published_since onward were published on their day (see record.json — each has a git commit timestamp).",
    attribution: ATTR,
    series,
  });

  // record.json — THE LEDGER. Append-only; never modify existing entries.
  const record = readJSON("record.json", { note: "As-published, append-only track record. Entries are immutable once written; every entry carries the git commit that published it.", entries: [] });
  if (!record.entries.some(e => e.date === dataThrough)) {
    record.entries.push({ date: dataThrough, value: r, zone: z.zone,
                          price_usd: Math.round(price[li] * 100) / 100,
                          computed_at: computedAt, stale });
  }
  writeJSON("record.json", record);

  // selftest.json — recompute the 19 frozen vectors from today's live data
  const idx = new Map(dates.map((d, i) => [d, i]));
  const results = TEST_VECTORS.map(([d, expected]) => {
    const i2 = idx.get(d);
    const got = i2 === undefined ? null : Math.round(risk[i2] * 10000) / 10000;
    const diff = got === null ? null : Math.round(Math.abs(got - expected) * 10000) / 10000;
    return { date: d, expected, got, diff, pass: diff !== null && diff <= 0.01 };
  });
  writeJSON("selftest.json", {
    all_pass: results.every(x => x.pass), tolerance: 0.01,
    computed_at: computedAt, results,
    note: "Live data recomputation of the 19 frozen acceptance vectors from spec v1.0.1.",
  });

  console.log(`OK  ${dataThrough}  index=${r}  zone=${z.zone}  stale=${stale}  rows=${rows.length}  selftest=${results.every(x => x.pass) ? "PASS" : "FAIL"}`);
  if (!results.every(x => x.pass)) process.exit(1);  // fail the workflow loudly
})().catch(e => { console.error("RUN FAILED:", e); process.exit(1); });
