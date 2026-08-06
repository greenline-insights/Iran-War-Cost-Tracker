# Iran War Cost Tracker — data pipeline

Automated daily pipeline behind the public tracker at
<https://www.greenlineinsights.com/cost-of-iran-war>. A scheduled GitHub Action
fetches daily Brent spot prices from the EIA API, recomputes the cumulative
cost series, and publishes a small `docs/tracker.json` via GitHub Pages. The
Squarespace page's header-injection script fetches that JSON once per page
load and drives the live "Running Tab" ticker.

## Methodology (v2.0-daily)

**Baseline:** EIA February 2026 Short-Term Energy Outlook (STEO) — projected
2026 Brent average of **$58/bbl** and projected 2026 U.S. petroleum
expenditures of **$435,467 million**.

**Damages formula:** implied annual incremental spending
= `435,467M × (Brent / 58 − 1)`.

The running tab integrates this over calendar time starting **2026-02-27**:

1. Fetch EIA **daily** Europe Brent spot (series `RBRTE`) from 2026-02-27
   through today.
2. Daily observations exist only on trading days (~250/yr). **Forward-fill**:
   every calendar day carries the most recent observed price, so weekends and
   holidays inherit Friday's price. Calendar days before the first
   observation (if any) are backfilled from it.
3. For each calendar day *d*:
   `daily_damage(d) = 435,467M × (price(d)/58 − 1) / 365`.
4. Running total = sum of `daily_damage` over all calendar days from
   2026-02-27 through the newest price date.
5. Live tick rate: `rate_per_second = 435,467M × (latest_price/58 − 1) / 31,536,000`
   (365-day year — intentionally replaces the v1 spreadsheet's
   `annual/52/604800`, which implied a 364-day year, ~0.27% high).

**Below-baseline floor:** if Brent falls below $58, raw daily damages go
negative. By explicit decision, negative daily increments (and a negative tick
rate) are **floored at zero** — the running tab never counts down. This is an
intentional asymmetry: sub-baseline days add $0 rather than crediting the tab.
Controlled by the `FLOOR_NEGATIVE_DAMAGES` constant in `build.js`.

**v2 restatement:** v2 recomputes all history on the daily basis, so the total
differs from the previously published weekly-basis (v1) figure. That is
expected and announced as a methodology restatement. Every run of `build.js`
prints a v2-vs-v1 comparison (last v1 state: $122,300,359,077 anchored
2026-07-17, $5,951.6/sec, Brent $82.93) for sanity checking.

Each run recomputes the **entire series from scratch** — never incremental
appends — so the pipeline self-heals from EIA data revisions and missed runs.

The monthly "Projected Losses" section of the page (per-household / GDP /
jobs / map) depends on IMPLAN model runs and remains **manual**; this pipeline
does not touch it. `household_factor` in the JSON is an IMPLAN output stored
as a constant in `build.js` — update it there only when the IMPLAN model is
rerun.

## tracker.json contract

```json
{
  "methodology_version": "2.0-daily",
  "generated_at": "<UTC ISO timestamp of last substantive rebuild>",
  "last_price_date": "<YYYY-MM-DD of newest EIA observation>",
  "latest_price_usd_bbl": "78.42",
  "pct_above_baseline": "35.21",
  "anchor_iso": "2026-08-05T00:00:00-04:00",
  "anchor_total_usd": "128450218400.00",
  "rate_per_second_usd": "5096.24",
  "household_factor": "0.00000000545075500193309",
  "last_updated_display": "August 5th, 2026"
}
```

All numerics are **decimal strings** — the client parses them into BigInt
micros (`parseDecimalToMicros`); float JSON would break it. Key order and
decimal places are fixed so output is byte-deterministic.

Anchor convention: `anchor_total_usd` is the cumulative total through the end
of `last_price_date`; `anchor_iso` is midnight **America/New_York** at the
start of the *next* day, with the correct numeric UTC offset for that date
(EDT `-04:00` vs EST `-05:00`) computed in `build.js`. The client just does
`new Date(anchor_iso).getTime()` and ticks forward at `rate_per_second_usd` —
no client-side DST logic.

## Repo layout

```
build.js                         # Node 20+ script, native fetch, no npm deps
.github/workflows/update.yml     # daily cron + manual dispatch
docs/tracker.json                # build output, served by GitHub Pages
squarespace-header-injection.html# canonical copy of the page's header injection
```

## Client (Squarespace header injection)

`squarespace-header-injection.html` is the canonical copy of the tracker
page's header code injection — edit it here, then paste the whole file into
Squarespace (Page Settings → Advanced → Page Header Code Injection). On page
load it paints instantly from the last good response cached in
`localStorage` (or a hardcoded fallback), fetches `tracker.json` with a 3s
timeout, and re-renders when fresh data arrives; a failed fetch leaves the
last known numbers ticking. The page's text block must contain
`<span id="gl-last-updated">…</span>` — the script writes
`last_updated_display` into it.

## Setup

1. **EIA API key** (free, instant): <https://www.eia.gov/opendata/>. Add it as
   the repository secret **`EIA_API_KEY`** (Settings → Secrets and variables →
   Actions).
2. **GitHub Pages**: Settings → Pages → Build and deployment → Source:
   **GitHub Actions**. The workflow's `deploy` job publishes `docs/` after
   every data change (the branch-based "deploy from a branch" mode does not
   work here: pushes made by the workflow's own token never trigger it, and
   its deploy pipeline proved unreliable). The JSON is served at
   `https://greenline-insights.github.io/Iran-War-Cost-Tracker/tracker.json`
   with permissive CORS (`Access-Control-Allow-Origin: *`), so the Squarespace
   cross-origin fetch works. Pages caches for ~10 minutes — fine for a
   daily-cadence number.
3. **First run**: trigger the *Update tracker data* workflow manually
   (Actions tab → Run workflow) and read its log — it prints the v2-vs-v1
   comparison for sign-off before cutover.

Local run: `EIA_API_KEY=yourkey node build.js`

## Ops notes

- **Publication lag**: EIA publishes daily spot prices a few business days
  behind. Most daily runs find nothing new; `build.js` then leaves
  `tracker.json` untouched (it ignores a `generated_at`-only difference) and
  the workflow commits nothing. `generated_at` therefore means "last
  substantive data change", not "last workflow run".
- **Scheduled-workflow auto-disable**: GitHub disables scheduled workflows
  after **60 days with no commits** to the repo (verified against current
  GitHub docs, Aug 2026). Normal EIA data flow produces several commits a
  week, which resets the clock. If GitHub ever emails that the workflow was
  disabled, re-enable it in the Actions tab and run a manual dispatch; that
  resets the clock. (Alternative mitigation, not implemented: a monthly
  heartbeat commit.)
- **Failure mode**: `build.js` exits nonzero on HTTP errors, empty payloads,
  or malformed rows and never writes JSON built from bad data. A failed run
  leaves the last good `tracker.json` in place; the page keeps ticking from
  the last anchor. GitHub emails the repo owner on workflow failure.
- **Cron time**: 09:17 UTC daily, deliberately off the hour (GitHub's
  scheduler is congested at :00).
