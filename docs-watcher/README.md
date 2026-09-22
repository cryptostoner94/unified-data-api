# docs-watcher — upstream change monitoring

*All data is officially sourced from the platforms' own public endpoints — our catalog mirrors the source truthfully. We sell convenience: one bundle, one interface, one bill.*

A scheduled job that watches every upstream endpoint in the PHASE 1 catalog
(spec §2.1 crypto + §2.2 enterprise) so breakage gets fixed before users notice.
Implements spec §5 (docs-watcher) and §7.4 (staleness monitoring).

## What it checks (per endpoint)

1. **Liveness** — GET the registry's cheap, read-only health-check URL
   (e.g. mempool `/api/blocks/tip/height`, SEC `company_tickers.json`, or the
   official docs page for keyed/WS endpoints). Alerts on non-2xx or latency
   above the threshold.
2. **Docs change** — SHA-256 of the official docs page vs the hash stored in
   `state.json`. On change, the new content is scanned for deprecation-related
   keywords (`deprecat*`, `sunset`, `breaking change`, …) and flagged.
3. **Schema drift** — a live sample response is validated against the minimal
   declared shape in the registry (field presence + type). Drift raises an
   alert mirroring the SDK's `UpstreamSchemaDrift` telemetry.
4. **Deprecation headers** — `Deprecation` / `Sunset` response headers are
   recorded and alerted when present.
5. **Staleness (§7.4)** — for feed-type sources, the newest-item timestamp is
   tracked per poll; an alert fires when a feed exceeds **3× its expected
   cadence** without a new item.

## Polite by design

- Descriptive `User-Agent` identifying this monitor. Set your contact so
  providers (esp. SEC) can reach you:
  `export WATCHER_CONTACT="Your Name <you@example.com>"`
- Per-host rate limiting (`min_interval_s`, default 1s; SEC set to 0.5s).
- Honors `Retry-After` on 429/503 (one retry, capped at 60s).
- Health checks are cheap and read-only — docs pages or single lightweight API
  calls. No secrets are used or needed.

## Layout

```
docs-watcher/
  endpoints.yaml   # registry: 24 PHASE 1 endpoints (14 crypto, 10 enterprise)
  watcher.py       # the runner (python3 watcher.py)
  state.json       # persisted docs hashes + feed timestamps (auto-updated)
  reports/         # watcher-YYYYMMDD.json, alerts.log
  tests/           # fully mocked pytest suite (zero network calls)
  requirements.txt
  README.md
```

## Quickstart

```bash
pip install -r requirements.txt
export WATCHER_CONTACT="Your Name <you@example.com>"

# validate the registry (no network)
python3 watcher.py --validate-only

# full daily run (24 endpoints)
python3 watcher.py

# hourly Tier-0 crypto subset (mempool, Binance, Kraken)
python3 watcher.py --tier0

# run the mocked test suite (makes ZERO real network calls)
python3 -m pytest tests/ -q
```

Exit codes: `0` = clean, `2` = one or more alerts. Alerts are also appended to
`reports/alerts.log` with timestamps.

## Cron examples

```cron
# Daily full run at 06:00 UTC — all 24 PHASE 1 endpoints
0 6 * * *  cd /path/to/docs-watcher && /usr/bin/python3 watcher.py >> /var/log/docs-watcher.log 2>&1

# Hourly Tier-0 crypto subset (mempool / Binance / Kraken)
0 * * * *  cd /path/to/docs-watcher && /usr/bin/python3 watcher.py --tier0 >> /var/log/docs-watcher.log 2>&1
```

Alerting hook (example): append a notifier after the run, e.g.

```cron
0 6 * * *  cd /path/to/docs-watcher && /usr/bin/python3 watcher.py || tail -20 reports/alerts.log | mail -s "docs-watcher alerts" ops@example.com
```

(Remember: exit code 2 means alerts were raised — wire that into whatever
paging/monitoring you already use.)

## How to add an endpoint

1. Add an entry to `endpoints.yaml` under `endpoints:` with:
   - `id` (unique slug), `bundle` (`crypto` / `enterprise`), `name`
   - `base_url` — **exact base URL from the spec; never invent one**
   - `docs_url` — the official docs page named in the spec
   - `tier` — `tier0` (hourly crypto) or `standard` (daily)
   - `health_check` — `{method, url, expect_status}`; must be cheap and
     read-only. For WS or key-gated APIs, use the official docs page.
   - `expected_shape` (optional) — minimal JSON shape guard, e.g.
     `{type: object, fields: {error: {type: array}, result: {type: object}}}`.
     `type` may be a single type or a list; types: `string integer number
     boolean array object null any`.
   - `feed` (optional, for §7.4 staleness) — `{url, timestamp_path,
     expected_cadence_s}`. `timestamp_path` is a dotted path into the JSON
     sample (`-1` = last array element, `*` = first dict value). Timestamps may
     be unix seconds/ms/µs, digit strings, or ISO-8601.
   - `rate_limit_s` (optional) — per-host minimum gap override.
   - `notes` — why this URL was chosen (helps future audits).
2. Run `python3 watcher.py --validate-only` — it must print `registry valid`.
3. Add a registry pin in `tests/test_watcher.py`
   (`test_registry_spec_base_urls_pinned`) if the base URL comes from the spec.
4. Run `python3 -m pytest tests/ -q` — all green before committing.

## Notes & honest boundaries

- The relay data APIs (Flashbots / Ultrasound / bloXroute) share the
  mev-boost-relay data API shape; their rate limits and ToS are unpublished
  (UNVERIFIED in the spec) — the watcher only performs the same cheap
  read-only calls a normal user would.
- WS endpoints (`mempool-ws`, `binance-ws`, `kraken-ws-v2`,
  `blockchain-info-ws`) are health-checked via their official docs pages;
  opening real sockets is out of scope for this job.
- First run baselines all docs hashes (no docs-change alerts on run #1).
