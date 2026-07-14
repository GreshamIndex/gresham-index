// gresham_engine.js — JavaScript port of the frozen v1.0.1 index engine
// Exact transcription of indicators.py (Python/pandas reference).
// Acceptance: reproduce test_vectors.csv within ±0.01 on all 19 dates.
//
// Input: array of rows {date: "YYYY-MM-DD", PriceUSD, CapMVRVCur, CapMrktCurUSD, IssTotUSD}
// (rows with missing/non-positive PriceUSD must be filtered out by the caller, matching load_data()).

"use strict";

const GENESIS_MS = Date.UTC(2009, 0, 3); // 2009-01-03
const MS_DAY = 86400000;

// ---------- helpers ----------

function daysSinceGenesis(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - GENESIS_MS) / MS_DAY;
}

function lastDayOfMonthUTC(y, mIdx) { // mIdx 0-based
  return new Date(Date.UTC(y, mIdx + 1, 0)).getUTCDate();
}

// rolling mean with pandas semantics: NaN if fewer than min_periods non-NaN in window
function rollingMean(v, window, minPeriods) {
  const n = v.length, out = new Float64Array(n).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const xi = v[i];
    if (!Number.isNaN(xi)) { sum += xi; cnt++; }
    const j = i - window;
    if (j >= 0) {
      const xj = v[j];
      if (!Number.isNaN(xj)) { sum -= xj; cnt--; }
    }
    if (cnt >= minPeriods) out[i] = sum / cnt;
  }
  return out;
}

// pandas rolling(window, min_periods).apply(pr, raw=True) with
// pr = (x[:-1] <= x[-1]).mean()  — NaN comparisons count as False,
// denominator = len(x)-1 (window INCLUDING NaN slots), and pandas gates
// the call on >= min_periods non-NaN values in the window.
function rollingPctRank(v, window, minPeriods = 365) {
  const n = v.length, out = new Float64Array(n).fill(NaN);
  // maintain rolling count of non-NaN for the gate
  let nonNaN = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(v[i])) nonNaN++;
    const start = Math.max(0, i - window + 1);
    if (i - window >= 0 && !Number.isNaN(v[i - window])) nonNaN--;
    const len = i - start + 1;
    if (len < 2) continue;
    if (nonNaN < minPeriods) continue;
    const cur = v[i];
    let cnt = 0;
    // NaN <= NaN and x <= NaN are all false; NaN <= cur is false
    if (!Number.isNaN(cur)) {
      for (let j = start; j < i; j++) {
        const xj = v[j];
        if (!Number.isNaN(xj) && xj <= cur) cnt++;
      }
    }
    out[i] = cnt / (len - 1);
  }
  return out;
}

// expanding sample std (ddof=1), NaN until min_periods non-NaN seen — Welford
function expandingStd(v, minPeriods) {
  const n = v.length, out = new Float64Array(n).fill(NaN);
  let cnt = 0, mean = 0, m2 = 0;
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (!Number.isNaN(x)) {
      cnt++;
      const d = x - mean;
      mean += d / cnt;
      m2 += d * (x - mean);
    }
    if (cnt >= minPeriods && cnt > 1) out[i] = Math.sqrt(m2 / (cnt - 1));
  }
  return out;
}

// least-squares line fit y = a + b*x  → [b, a]  (mirrors np.polyfit deg 1)
function linfit(x, y, len) {
  let sx = 0, sy = 0;
  for (let i = 0; i < len; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / len, my = sy / len;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < len; i++) {
    const dx = x[i] - mx;
    sxx += dx * dx;
    sxy += dx * (y[i] - my);
  }
  const b = sxy / sxx;
  return [b, my - b * mx];
}

// ---------- indicators (transcription of compute_indicators) ----------

function expandingLogRegression(dates, price, startAfter = 1200, refitEvery = 30) {
  const n = price.length;
  const logd = new Float64Array(n), logp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    logd[i] = Math.log(daysSinceGenesis(dates[i]));
    logp[i] = Math.log(price[i]);
  }
  const dev = new Float64Array(n).fill(NaN);
  let a = NaN, b = NaN;
  for (let i = startAfter; i < n; i++) {
    if ((i - startAfter) % refitEvery === 0) {
      [b, a] = linfit(logd, logp, i); // fit on data up to (not including) i
    }
    dev[i] = logp[i] - (a + b * logd[i]);
  }
  return dev;
}

function monthlyRSI(dates, price) {
  // resample("ME").last(): last observation per calendar month, labeled at month-end
  const monthEnd = [], monthVal = [];
  let curKey = "", curVal = NaN, curLabel = "";
  for (let i = 0; i < price.length; i++) {
    const key = dates[i].slice(0, 7);
    if (key !== curKey) {
      if (curKey !== "") { monthEnd.push(curLabel); monthVal.push(curVal); }
      curKey = key;
      const y = +key.slice(0, 4), m = +key.slice(5, 7) - 1;
      curLabel = `${key}-${String(lastDayOfMonthUTC(y, m)).padStart(2, "0")}`;
    }
    curVal = price[i];
  }
  if (curKey !== "") { monthEnd.push(curLabel); monthVal.push(curVal); }

  // delta, gain/loss ewm(alpha=1/14, adjust=True, ignore_na=False), min_periods=14
  const M = monthVal.length, alpha = 1 / 14, q = 1 - alpha;
  const rsi = new Float64Array(M).fill(NaN);
  let gNum = 0, gDen = 0, lNum = 0, lDen = 0, valid = 0;
  for (let t = 0; t < M; t++) {
    const delta = t === 0 ? NaN : monthVal[t] - monthVal[t - 1];
    // absolute-position decay (ignore_na=False): decay every step, add only if valid
    gNum *= q; gDen *= q; lNum *= q; lDen *= q;
    if (!Number.isNaN(delta)) {
      valid++;
      gNum += Math.max(delta, 0); gDen += 1;
      lNum += Math.max(-delta, 0); lDen += 1;
    }
    if (valid >= 14) {
      const gain = gNum / gDen, loss = lNum / lDen;
      rsi[t] = 100 - 100 / (1 + gain / loss);
    }
  }
  // reindex to daily with ffill: value of latest month-end label <= date
  const n = dates.length, out = new Float64Array(n).fill(NaN);
  let p = -1;
  for (let i = 0; i < n; i++) {
    while (p + 1 < M && monthEnd[p + 1] <= dates[i]) p++;
    if (p >= 0) out[i] = rsi[p];
  }
  return out;
}

function computeIndicators(rows) {
  const n = rows.length;
  const dates = rows.map(r => r.date);
  const price = new Float64Array(n), mvrv = new Float64Array(n),
        mc = new Float64Array(n), iss = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    price[i] = rows[i].PriceUSD;
    mvrv[i]  = numOrNaN(rows[i].CapMVRVCur);
    mc[i]    = numOrNaN(rows[i].CapMrktCurUSD);
    iss[i]   = numOrNaN(rows[i].IssTotUSD);
  }

  // Family 1: trend
  const ma200 = rollingMean(price, 200, 200);
  const ma1400 = rollingMean(price, 1400, 1000);
  const mayer = new Float64Array(n), ext200w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mayer[i] = price[i] / ma200[i];      // NaN/NaN propagate naturally
    ext200w[i] = price[i] / ma1400[i];
  }
  const logregDev = expandingLogRegression(dates, price);

  // Family 2: on-chain
  const mcStd = expandingStd(mc, 365);
  const mvrvZ = new Float64Array(n), nupl = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rc = mc[i] / mvrv[i];
    mvrvZ[i] = (mc[i] - rc) / mcStd[i];
    nupl[i] = 1 - 1 / mvrv[i];
  }
  const iss365 = rollingMean(iss, 365, 180);
  const puell = new Float64Array(n);
  for (let i = 0; i < n; i++) puell[i] = iss[i] / iss365[i];

  // Family 3: momentum
  const rsiM = monthlyRSI(dates, price);

  return { dates, price, mayer, ext_200w: ext200w, logreg_dev: logregDev,
           mvrv_z: mvrvZ, nupl, puell, rsi_monthly: rsiM };
}

function numOrNaN(x) {
  return (x === undefined || x === null || x === "" || Number.isNaN(+x)) ? NaN : +x;
}

// ---------- normalization + composite (v1.0.1, halving OFF, raw mvrv unused) ----------

const WEIGHTS = { // family weight × within-family weight
  mayer: 0.35 * 0.3, ext_200w: 0.35 * 0.3, logreg_dev: 0.35 * 0.4,
  mvrv_z: 0.40 * 0.4, nupl: 0.40 * 0.3, puell: 0.40 * 0.3,
  rsi_monthly: 0.25 * 1.0,
};
const COLS = Object.keys(WEIGHTS);

function compositeForWindow(ind, window) {
  const n = ind.dates.length;
  const norm = {};
  for (const c of COLS) norm[c] = rollingPctRank(ind[c], window, 365);
  const raw = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let total = 0, wsum = 0;
    for (const c of COLS) {
      const v = norm[c][i];
      if (!Number.isNaN(v)) { total += v * WEIGHTS[c]; wsum += WEIGHTS[c]; }
    }
    if (wsum > 0) raw[i] = total / wsum;
  }
  // 7-day rolling mean, min_periods=1
  return rollingMean(raw, 7, 1);
}

// The Gresham Index: 50/50 blend of 4y and 8y percentile windows
function greshamIndex(rows) {
  const ind = computeIndicators(rows);
  const c4 = compositeForWindow(ind, 1460);
  const c8 = compositeForWindow(ind, 2920);
  const n = ind.dates.length;
  const risk = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) risk[i] = 0.5 * c4[i] + 0.5 * c8[i]; // NaN propagates
  return { dates: ind.dates, price: ind.price, risk };
}

module.exports = { greshamIndex, computeIndicators, rollingPctRank, expandingStd, monthlyRSI };
