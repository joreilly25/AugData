# AugData

A data pipeline and web dashboard for analyzing **Augmentation Evoker** contribution in World of Warcraft raid encounters, using data from the [Warcraft Logs API](https://www.warcraftlogs.com/api/docs).

## What it does

- Discovers and processes Warcraft Logs reports containing Augmentation Evokers
- Calculates how much damage each DPS spec gains from Aug buffs (primarily Ebon Might)
- Measures damage elasticity: % damage increase per 1% primary stat increase from buffs
- Serves a web dashboard with spec scaling rankings, prescience targeting recommendations, and per-boss breakdowns

## Prerequisites

- Node.js v18+
- Warcraft Logs API credentials (free) — register at https://www.warcraftlogs.com/api/clients

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and fill in WCL_CLIENT_ID and WCL_CLIENT_SECRET
```

## Usage

### Web dashboard

```bash
npm start
```

Starts the Express server on port 3000. The dashboard loads pre-built summaries and runs the data pipeline in the background every 6 hours.

### Analyze a single report

```bash
node aug_data.mjs <report-code-or-url> [-f fight_ids]

# Examples
node aug_data.mjs tKXzav2Q738nx6TW
node aug_data.mjs https://www.warcraftlogs.com/reports/tKXzav2Q738nx6TW
node aug_data.mjs tKXzav2Q738nx6TW -f 3,5,7
```

### Run the automated pipeline

Discovers reports from WCL rankings and processes them in batch:

```bash
node pipeline.mjs [options]
  --zone,       -z   Zone ID (defaults to latest tier)
  --difficulty, -d   3=Normal 4=Heroic 5=Mythic (default: 5)
  --samples,    -s   Target number of reports (default: 200)
```

### Discover new reports

Crawls WCL encounter rankings and appends new report codes to `reports.txt`:

```bash
node discover_reports.mjs [--zone <id>] [-d <difficulty>] [--pages <n>]
```

### Rebuild dashboard summaries

Recompiles summaries from existing raw data without re-fetching anything:

```bash
node build-summary.mjs
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WCL_CLIENT_ID` | Yes | — | WCL OAuth client ID |
| `WCL_CLIENT_SECRET` | Yes | — | WCL OAuth client secret |
| `PORT` | No | `3000` | Web server port |
| `DATA_DIR` | No | `./data` | Directory for stored data |
| `PIPELINE_INTERVAL_HOURS` | No | `6` | How often the background pipeline runs |

## How it works

1. **Discovery** — `pipeline.mjs` / `discover_reports.mjs` query WCL rankings to find reports where an Augmentation Evoker was present.
2. **Analysis** — `aug_data.mjs` authenticates with the WCL GraphQL API, fetches fight metadata and player stats, and calculates per-spec damage attribution and scaling elasticity for each Aug in the report.
3. **Aggregation** — Raw results are accumulated in `data/aggregate_scaling.json`.
4. **Summarization** — `build-summary.mjs` groups data by spec, encounter, and boss, computes averages, and writes compact JSON to `data/summaries/`.
5. **Dashboard** — The Express server exposes `/api/*` endpoints backed by those summaries; the vanilla JS frontend renders the tables and handles filtering.

## Key metrics

- **Elasticity** — Damage % gained per 1% primary stat increase; the primary measure of how well a spec scales with Aug buffs
- **Attribution %** — Fraction of a player's total damage attributed to Aug buffs
- **Aug DPS** — Damage per second contributed by buffs
