#!/usr/bin/env node
'use strict';

// Iran War Oil Cost Tracker — daily build (methodology v2).
//
// Fetches daily Europe Brent spot prices (EIA series RBRTE) from the EIA v2
// API, recomputes the full damages series from scratch, and writes
// docs/tracker.json for GitHub Pages. Run: EIA_API_KEY=... node build.js
//
// Requires Node 20+ (native fetch, full ICU for timezone offsets). No npm deps.

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------
const METHODOLOGY_VERSION = '2.0-daily';

// Baseline: EIA February 2026 Short-Term Energy Outlook (STEO).
const BASELINE_BRENT_USD = 58; // projected 2026 Brent average, $/bbl
const ANNUAL_EXPENDITURE_USD = 435467e6; // projected 2026 U.S. petroleum expenditures

const WAR_START_DATE = '2026-02-27'; // first calendar day the running tab covers
const DAYS_PER_YEAR = 365;
const SECONDS_PER_YEAR = DAYS_PER_YEAR * 24 * 3600; // 31,536,000

// Methodology v2 decision (Jonah, 2026-08-06): days with Brent below the $58
// baseline contribute $0 rather than negative damages, so the running tab
// never counts down. Applies to both the daily series and the live tick rate.
// The README methodology note discloses this asymmetry.
const FLOOR_NEGATIVE_DAMAGES = true;

// household_factor is a model output (household share of impacts divided by
// U.S. household count) from the IMPLAN run. It changes ONLY when the IMPLAN
// model is rerun — update the value here by hand when that happens. It is
// passed through to tracker.json untouched; build.js does no math with it.
const HOUSEHOLD_FACTOR = '0.0000000054508';

// Last figures published under methodology v1 (weekly basis), kept only so
// each run can print an old-vs-new comparison for sanity checking.
const V1_REFERENCE = {
  total_usd: 122300359077,
  anchor_date: '2026-07-17',
  rate_per_second: 5951.6,
  brent: 82.93,
  pct_above_baseline: 42.98,
};

const EIA_DATA_URL = 'https://api.eia.gov/v2/petroleum/pri/spt/data/';
const EIA_SERIES = 'RBRTE'; // Europe Brent spot price FOB, daily
const EIA_PAGE_SIZE = 5000; // EIA v2 max rows per request

const OUT_PATH = path.join(__dirname, 'docs', 'tracker.json');

// ---------------------------------------------------------------------------
// EIA fetch
// ---------------------------------------------------------------------------
async function fetchAllRows(apiKey, startDate, endDate) {
  const rows = [];
  let total = Infinity;
  let offset = 0;
  while (rows.length < total) {
    const params = new URLSearchParams({
      api_key: apiKey,
      frequency: 'daily',
      'data[0]': 'value',
      'facets[series][]': EIA_SERIES,
      start: startDate,
      end: endDate,
      'sort[0][column]': 'period',
      'sort[0][direction]': 'asc',
      offset: String(offset),
      length: String(EIA_PAGE_SIZE),
    });
    const res = await fetch(`${EIA_DATA_URL}?${params}`);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`EIA API returned HTTP ${res.status} at offset ${offset}: ${body}`);
    }
    const payload = await res.json();
    const response = payload && payload.response;
    if (!response || !Array.isArray(response.data)) {
      throw new Error(`Unexpected EIA payload shape: ${JSON.stringify(payload).slice(0, 500)}`);
    }
    total = Number(response.total);
    if (!Number.isFinite(total)) {
      throw new Error(`EIA response.total is not numeric: ${JSON.stringify(response.total)}`);
    }
    if (response.data.length === 0 && rows.length < total) {
      throw new Error(`EIA pagination stalled: got ${rows.length} of ${total} rows`);
    }
    rows.push(...response.data);
    offset += response.data.length;
  }
  return rows;
}

// Validates raw EIA rows and returns a sorted array of { date, price }.
function parseObservations(rows, startDate) {
  if (rows.length === 0) {
    throw new Error(`EIA returned zero ${EIA_SERIES} rows since ${startDate} — refusing to build.`);
  }
  const byDate = new Map();
  for (const row of rows) {
    if (typeof row.period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.period)) {
      throw new Error(`Malformed EIA row (bad period): ${JSON.stringify(row).slice(0, 300)}`);
    }
    const price = Number(row.value);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Malformed EIA row (bad value): ${JSON.stringify(row).slice(0, 300)}`);
    }
    const existing = byDate.get(row.period);
    if (existing !== undefined && existing !== price) {
      throw new Error(`Conflicting EIA values for ${row.period}: ${existing} vs ${price}`);
    }
    byDate.set(row.period, price);
  }
  return [...byDate.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Calendar / series math
// ---------------------------------------------------------------------------
function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + 86400e3).toISOString().slice(0, 10);
}

// Expands trading-day observations into a complete calendar-day series from
// startDate through the last observation, forward-filling non-trading days.
// Calendar days before the first observation are backfilled from it.
function forwardFill(observations, startDate) {
  const priceByDate = new Map(observations.map((o) => [o.date, o.price]));
  const first = observations[0];
  const last = observations[observations.length - 1];
  if (last.date < startDate) {
    throw new Error(`Newest EIA observation (${last.date}) predates start date ${startDate}.`);
  }
  const days = [];
  let price = null;
  let backfilled = 0;
  for (let d = startDate; d <= last.date; d = nextDay(d)) {
    if (priceByDate.has(d)) {
      price = priceByDate.get(d);
    } else if (price === null) {
      price = first.price; // no observation yet — backfill from the first one
    }
    if (d < first.date) backfilled += 1;
    days.push({ date: d, price });
  }
  if (backfilled > 0) {
    console.warn(
      `NOTE: ${backfilled} calendar day(s) before the first EIA observation (${first.date}) ` +
        `were backfilled with that observation's price ($${first.price}).`
    );
  }
  return days;
}

function dailyDamageUsd(price) {
  const raw = (ANNUAL_EXPENDITURE_USD * (price / BASELINE_BRENT_USD - 1)) / DAYS_PER_YEAR;
  return FLOOR_NEGATIVE_DAMAGES ? Math.max(0, raw) : raw;
}

function ratePerSecondUsd(price) {
  const raw = (ANNUAL_EXPENDITURE_USD * (price / BASELINE_BRENT_USD - 1)) / SECONDS_PER_YEAR;
  return FLOOR_NEGATIVE_DAMAGES ? Math.max(0, raw) : raw;
}

// ---------------------------------------------------------------------------
// Eastern-time anchor (replaces the client's hand-rolled DST logic)
// ---------------------------------------------------------------------------
function easternOffsetMinutesAt(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(utcMs);
  const name = parts.find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-04:00"
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`Cannot parse Eastern offset from ${JSON.stringify(name)}`);
  if (!m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// Full ISO string for midnight America/New_York at the start of dateStr,
// with the correct numeric offset for that date (EDT vs EST).
function easternMidnightIso(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // First guess from an instant safely inside the same local date, then
  // re-check at the implied instant (DST shifts at 2am local, never midnight).
  let offset = easternOffsetMinutesAt(utcMidnight + 5 * 3600e3);
  offset = easternOffsetMinutesAt(utcMidnight - offset * 60e3);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${dateStr}T00:00:00${sign}${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

function displayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${ordinal(d)}, ${y}`;
}

// ---------------------------------------------------------------------------
// Tracker assembly
// ---------------------------------------------------------------------------
// All numerics are fixed-precision decimal STRINGS: the client parses them
// into BigInt micros via parseDecimalToMicros, and float JSON would break it.
// Key order and decimal places are fixed so output is deterministic and the
// workflow's commit-if-changed guard is meaningful.
function buildTracker(observations, generatedAt) {
  const days = forwardFill(observations, WAR_START_DATE);
  const lastObs = observations[observations.length - 1];
  const totalUsd = days.reduce((sum, day) => sum + dailyDamageUsd(day.price), 0);
  const latest = lastObs.price;
  return {
    tracker: {
      methodology_version: METHODOLOGY_VERSION,
      generated_at: generatedAt,
      last_price_date: lastObs.date,
      latest_price_usd_bbl: latest.toFixed(2),
      pct_above_baseline: ((latest / BASELINE_BRENT_USD - 1) * 100).toFixed(2),
      // Total covers every calendar day through last_price_date; the client
      // ticks forward from midnight Eastern at the start of the NEXT day.
      anchor_iso: easternMidnightIso(nextDay(lastObs.date)),
      anchor_total_usd: totalUsd.toFixed(2),
      rate_per_second_usd: ratePerSecondUsd(latest).toFixed(2),
      household_factor: HOUSEHOLD_FACTOR,
      last_updated_display: displayDate(lastObs.date),
    },
    days,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const GENERATED_AT_LINE = /^\s*"generated_at":.*\n/m;

// Writes tracker.json only when something besides generated_at changed, so
// the workflow's git-diff guard skips days with no new EIA data.
function writeIfChanged(tracker, outPath) {
  const json = `${JSON.stringify(tracker, null, 2)}\n`;
  if (fs.existsSync(outPath)) {
    const existing = fs.readFileSync(outPath, 'utf8');
    if (existing.replace(GENERATED_AT_LINE, '') === json.replace(GENERATED_AT_LINE, '')) {
      return false;
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  return true;
}

function printSummary(tracker, days) {
  const filled = days.filter((d, i) => i > 0 && days[i - 1].price === d.price).length;
  console.log('--- methodology v2 (daily) run summary -------------------------------');
  console.log(`  calendar days covered:   ${days[0].date} → ${days[days.length - 1].date} (${days.length} days)`);
  console.log(`  latest Brent (RBRTE):    $${tracker.latest_price_usd_bbl}/bbl on ${tracker.last_price_date}`);
  console.log(`  above $${BASELINE_BRENT_USD} baseline:      ${tracker.pct_above_baseline}%`);
  console.log(`  running total:           $${Number(tracker.anchor_total_usd).toLocaleString('en-US')}`);
  console.log(`  tick rate:               $${tracker.rate_per_second_usd}/sec`);
  console.log(`  anchor:                  ${tracker.anchor_iso}`);
  console.log('--- vs. last published v1 (weekly) figures ---------------------------');
  console.log(`  v1 running total:        $${V1_REFERENCE.total_usd.toLocaleString('en-US')} (anchored ${V1_REFERENCE.anchor_date})`);
  console.log(`  v1 tick rate:            $${V1_REFERENCE.rate_per_second}/sec at Brent $${V1_REFERENCE.brent} (${V1_REFERENCE.pct_above_baseline}% above baseline)`);
  console.log('  Totals are expected to differ (v2 restatement) but should be the');
  console.log('  same order of magnitude. Sanity-check before cutover.');
  console.log('-----------------------------------------------------------------------');
}

// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error('EIA_API_KEY environment variable is not set. Get a free key at https://www.eia.gov/opendata/');
  }
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Fetching daily ${EIA_SERIES} from EIA, ${WAR_START_DATE} → ${today} ...`);
  const rows = await fetchAllRows(apiKey, WAR_START_DATE, today);
  const observations = parseObservations(rows, WAR_START_DATE);
  console.log(`Got ${observations.length} trading-day observations (${observations[0].date} → ${observations[observations.length - 1].date}).`);

  const { tracker, days } = buildTracker(observations, new Date().toISOString());
  printSummary(tracker, days);

  if (writeIfChanged(tracker, OUT_PATH)) {
    console.log(`Wrote ${path.relative(process.cwd(), OUT_PATH)}`);
  } else {
    console.log('No substantive change (only generated_at differs) — tracker.json left untouched.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`BUILD FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  BASELINE_BRENT_USD,
  ANNUAL_EXPENDITURE_USD,
  WAR_START_DATE,
  FLOOR_NEGATIVE_DAMAGES,
  HOUSEHOLD_FACTOR,
  fetchAllRows,
  parseObservations,
  forwardFill,
  dailyDamageUsd,
  ratePerSecondUsd,
  easternMidnightIso,
  ordinal,
  displayDate,
  buildTracker,
  writeIfChanged,
};
