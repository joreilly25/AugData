/**
 * Discover Warcraft Logs reports containing Augmentation Evokers.
 *
 * Crawls encounter characterRankings filtered to Evoker / Augmentation,
 * extracts unique report codes, and appends them to reports.txt (deduped
 * against whatever is already there).
 *
 * Usage:
 *   node discover_reports.mjs [options]
 *
 * Options:
 *   --zone, -z       Zone ID to crawl (default: current tier auto-detected)
 *   --difficulty, -d  Difficulty: 3=Normal, 4=Heroic, 5=Mythic (default: 5)
 *   --pages, -p       Max pages to fetch per encounter (default: 10)
 *   --metric, -m      Ranking metric (default: dps)
 *   --output, -o      Output file path (default: ./reports.txt)
 *   --help, -h        Show this help
 */

import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_URL = "https://www.warcraftlogs.com/api/v2/client";

// ---------------------------------------------------------------------------
// Auth (same as aug_data.mjs)
// ---------------------------------------------------------------------------

async function getAccessToken(clientId, clientSecret) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    throw new Error(`Auth failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token;
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(token, query, variables = {}, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (resp.status === 429) {
      const wait = Math.min(2 ** attempt * 2000, 30000);
      console.warn(`  Rate limited — waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`API error: ${resp.status} ${await resp.text()}`);
    }

    const body = await resp.json();
    if (body.errors) {
      for (const err of body.errors) {
        console.error(`  GraphQL error: ${err.message}`);
      }
      throw new Error("GraphQL errors (see above)");
    }
    return body.data;
  }
  throw new Error("Rate limit retries exhausted");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const ZONE_LIST_QUERY = `
query {
  worldData {
    expansions {
      id
      name
      zones {
        id
        name
      }
    }
  }
}`;

const ENCOUNTER_LIST_QUERY = `
query ($zoneID: Int!) {
  worldData {
    zone(id: $zoneID) {
      name
      encounters {
        id
        name
      }
    }
  }
}`;

// characterRankings returns opaque JSON — the shape is:
// { page, hasMorePages, count, rankings: [{ name, class, spec, reportCode, fightID, ... }] }
const RANKINGS_QUERY = `
query ($encounterID: Int!, $className: String!, $specName: String!, $difficulty: Int!, $metric: CharacterRankingMetricType!, $page: Int!) {
  worldData {
    encounter(id: $encounterID) {
      characterRankings(
        className: $className
        specName: $specName
        difficulty: $difficulty
        metric: $metric
        page: $page
      )
    }
  }
}`;

// ---------------------------------------------------------------------------
// Discovery logic
// ---------------------------------------------------------------------------

async function getEncounters(token, zoneID) {
  const data = await gql(token, ENCOUNTER_LIST_QUERY, { zoneID });
  const zone = data.worldData.zone;
  if (!zone) throw new Error(`Zone ${zoneID} not found`);
  return { zoneName: zone.name, encounters: zone.encounters };
}

async function crawlEncounterRankings(
  token,
  encounterID,
  encounterName,
  { difficulty, metric, maxPages }
) {
  const codes = new Set();
  let page = 1;

  while (page <= maxPages) {
    if (page > 1) await sleep(500); // gentle pacing between pages

    process.stdout.write(
      `  ${encounterName} — page ${page}...`
    );

    const data = await gql(token, RANKINGS_QUERY, {
      encounterID,
      className: "Evoker",
      specName: "Augmentation",
      difficulty,
      metric,
      page,
    });

    const rankings = data.worldData.encounter.characterRankings;
    if (!rankings || !rankings.rankings || !rankings.rankings.length) {
      console.log(" no data");
      break;
    }

    let newOnPage = 0;
    for (const entry of rankings.rankings) {
      const code =
        entry.report?.code ?? entry.reportCode ?? entry.reportID ?? null;
      // Skip anonymized reports (prefixed "a:") — not fetchable
      if (!code || code.startsWith("a:")) continue;
      if (!codes.has(code)) {
        codes.add(code);
        newOnPage++;
      }
    }

    console.log(
      ` ${rankings.rankings.length} rankings, ${newOnPage} new codes (${codes.size} total)`
    );

    if (!rankings.hasMorePages) break;
    page++;
  }

  return codes;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function loadExistingCodes(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    const codes = new Set();
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Extract code from URL or bare code
      const match = trimmed.match(/reports\/([A-Za-z0-9]+)/);
      codes.add(match ? match[1] : trimmed);
    }
    return codes;
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      zone: { type: "string", short: "z" },
      difficulty: { type: "string", short: "d", default: "4" },
      pages: { type: "string", short: "p", default: "10" },
      metric: { type: "string", short: "m", default: "dps" },
      output: { type: "string", short: "o", default: "reports.txt" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(
      "Usage: node discover_reports.mjs [-z zoneID] [-d difficulty] [-p maxPages] [-m metric] [-o output.txt]"
    );
    console.log("\nDifficulty: 3=Normal, 4=Heroic, 5=Mythic (default: 5)");
    console.log("Pages: max ranking pages per encounter (default: 10, ~1000 rankings)");
    console.log("Metric: dps (default), hps, bossdps");
    console.log("\nAppends new report codes to the output file (deduped).");
    process.exit(0);
  }

  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Error: Set WCL_CLIENT_ID and WCL_CLIENT_SECRET env vars.");
    process.exit(1);
  }

  const difficulty = parseInt(values.difficulty, 10);
  const maxPages = parseInt(values.pages, 10);
  const metric = values.metric;
  const outputPath = resolve(values.output);

  const token = await getAccessToken(clientId, clientSecret);

  // Auto-detect current raid zone — pick highest zone ID that's an actual raid
  let zoneID;
  if (values.zone) {
    zoneID = parseInt(values.zone, 10);
  } else {
    const data = await gql(token, ZONE_LIST_QUERY);
    let best = null;
    const skip = /complete raids|mythic\+|delves|challenge|torghast|mage tower|beta/i;
    for (const exp of data.worldData.expansions) {
      for (const z of exp.zones) {
        if (skip.test(z.name)) continue;
        if (z.id >= 500) continue;
        if (!best || z.id > best.id) best = { ...z, expName: exp.name };
      }
    }
    if (!best) { console.error("No raid zones found"); process.exit(1); }
    zoneID = best.id;
    console.log(`Auto-detected latest zone: ${best.name} (id=${zoneID}) from ${best.expName}`);
  }

  const { zoneName, encounters } = await getEncounters(token, zoneID);
  const diffLabel = { 3: "Normal", 4: "Heroic", 5: "Mythic" }[difficulty] ?? `diff=${difficulty}`;

  console.log(
    `\nCrawling ${zoneName} — ${diffLabel} — ${encounters.length} encounters — up to ${maxPages} pages each\n`
  );

  // Load existing report codes to deduplicate
  const existingCodes = await loadExistingCodes(outputPath);
  const prevCount = existingCodes.size;
  if (prevCount) {
    console.log(`${prevCount} existing codes in ${outputPath}\n`);
  }

  const allNewCodes = new Set();

  for (const enc of encounters) {
    const codes = await crawlEncounterRankings(token, enc.id, enc.name, {
      difficulty,
      metric,
      maxPages,
    });

    for (const code of codes) {
      if (!existingCodes.has(code)) {
        allNewCodes.add(code);
      }
    }
  }

  // Append new codes to file
  if (allNewCodes.size) {
    const lines = [...allNewCodes].map(
      (code) => `https://www.warcraftlogs.com/reports/${code}`
    );

    let prefix = "";
    // If file exists and doesn't end with newline, add one
    try {
      const existing = await readFile(outputPath, "utf-8");
      if (existing.length && !existing.endsWith("\n")) {
        prefix = "\n";
      }
    } catch {
      // File doesn't exist yet — we'll create it
    }

    await writeFile(
      outputPath,
      prefix + lines.join("\n") + "\n",
      { flag: "a" } // append
    );
  }

  console.log(
    `\nDone. ${allNewCodes.size} new report codes found (${prevCount + allNewCodes.size} total in ${outputPath})`
  );
}

main();
