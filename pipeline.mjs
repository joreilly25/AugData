/**
 * AugData Pipeline — fully automated discovery + processing.
 *
 * 1. Crawls WCL encounter rankings for Augmentation Evokers, sampling
 *    across the full ranking spectrum (weighted toward mid/low percentiles).
 * 2. For each discovered report, runs the same attribution analysis as
 *    aug_data.mjs and merges results into aggregate_scaling.json.
 * 3. On rate-limit (429), waits patiently and resumes — safe to leave running.
 *
 * Usage:
 *   node pipeline.mjs [options]
 *
 * Options:
 *   --zone, -z          Zone ID (default: auto-detect latest)
 *   --difficulty, -d    3=Normal, 4=Heroic, 5=Mythic (default: 5)
 *   --samples, -s       Target report count to discover (default: 200)
 *   --help, -h          Show help
 */

import { config } from "dotenv";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_URL = "https://www.warcraftlogs.com/api/v2/client";
const EBON_MIGHT_COEFF = 0.208;

const AGG_PATH = join(DATA_DIR, "aggregate_scaling.json");
const BUCKETS_PATH = join(DATA_DIR, "aggregate_buckets.json");
const PROCESSED_PATH = join(DATA_DIR, "processed_codes.json");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIFF_MAP = { 3: "Normal", 4: "Heroic", 5: "Mythic" };

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.floor(n));
}

function pad(str, len, right = false) {
  if (right) return String(str).padStart(len);
  return String(str).padEnd(len);
}

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ---------------------------------------------------------------------------
// Auth
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
  return (await resp.json()).access_token;
}

// ---------------------------------------------------------------------------
// Rate limit tracking
// ---------------------------------------------------------------------------

const rateLimit = {
  limitPerHour: 3600,
  pointsSpent: 0,
  resetIn: 3600,       // seconds until reset
  lastChecked: 0,       // Date.now() of last check
  /** Estimated points remaining right now. */
  get remaining() {
    // If time has passed since last check, the reset may have happened
    const elapsed = (Date.now() - this.lastChecked) / 1000;
    if (elapsed >= this.resetIn) return this.limitPerHour;
    return Math.max(0, this.limitPerHour - this.pointsSpent);
  },
  /** Seconds until reset, adjusted for elapsed time. */
  get resetInNow() {
    const elapsed = (Date.now() - this.lastChecked) / 1000;
    return Math.max(0, this.resetIn - elapsed);
  },
  update(data) {
    if (!data) return;
    this.limitPerHour = data.limitPerHour ?? this.limitPerHour;
    this.pointsSpent = data.pointsSpentThisHour ?? this.pointsSpent;
    this.resetIn = data.pointsResetIn ?? this.resetIn;
    this.lastChecked = Date.now();
  },
};

// Inject rateLimitData into every query so we always know where we stand
function injectRateLimit(query) {
  // Insert rateLimitData at the top level of the query
  return query.replace(/\{\s*/, "{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } ");
}

// ---------------------------------------------------------------------------
// GraphQL — with rate-limit awareness
// ---------------------------------------------------------------------------

async function gql(token, query, variables = {}, { exitOnError = false } = {}) {
  // Proactive pause: if we're above 90% usage, wait for reset
  if (rateLimit.remaining < rateLimit.limitPerHour * 0.1 && rateLimit.lastChecked > 0) {
    const waitSec = Math.ceil(rateLimit.resetInNow) + 2;
    if (waitSec > 1) {
      const pct = ((rateLimit.pointsSpent / rateLimit.limitPerHour) * 100).toFixed(0);
      console.log(`\n  [${ts()}] ${pct}% of rate budget used — pausing ${waitSec}s for reset...`);
      await sleep(waitSec * 1000);
    }
  }

  const augmentedQuery = injectRateLimit(query);

  for (let attempt = 0; attempt < 10; attempt++) {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: augmentedQuery, variables }),
    });

    if (resp.status === 429) {
      // Use our tracked resetIn if available, otherwise escalating backoff
      const wait = rateLimit.lastChecked
        ? (Math.ceil(rateLimit.resetInNow) + 5) * 1000
        : Math.min(2 ** attempt * 5000, 300_000);
      const waitSec = Math.round(wait / 1000);
      console.log(`  [${ts()}] Rate limited — waiting ${waitSec}s for reset (attempt ${attempt + 1})...`);
      await sleep(wait);
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text();
      if (exitOnError) throw new Error(`API ${resp.status}: ${body}`);
      console.error(`  API error ${resp.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const body = await resp.json();

    // Update rate limit tracker from piggybacked data
    if (body.data?.rateLimitData) {
      rateLimit.update(body.data.rateLimitData);
      delete body.data.rateLimitData; // don't leak into caller's data
    }

    if (body.errors) {
      for (const err of body.errors) console.error(`  GQL error: ${err.message}`);
      if (exitOnError) throw new Error("GraphQL errors");
      return null;
    }
    return body.data;
  }
  throw new Error("Rate limit retries exhausted");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const ZONE_LIST_QUERY = `query {
  worldData { expansions { id name zones { id name } } }
}`;

const ENCOUNTER_LIST_QUERY = `query ($zoneID: Int!) {
  worldData { zone(id: $zoneID) { name encounters { id name } } }
}`;

const RANKINGS_QUERY = `
query ($encounterID: Int!, $page: Int!, $difficulty: Int!, $metric: CharacterRankingMetricType!) {
  worldData {
    encounter(id: $encounterID) {
      characterRankings(
        className: "Evoker"
        specName: "Augmentation"
        difficulty: $difficulty
        metric: $metric
        page: $page
      )
    }
  }
}`;

const REPORT_QUERY = `query ($code: String!) {
  reportData { report(code: $code) {
    title startTime endTime
    masterData { actors(type: "Player") { id name type subType server } }
    fights(killType: Encounters) {
      id encounterID name kill startTime endTime difficulty size bossPercentage friendlyPlayers
      gameZone { id name }
    }
  }}
}`;

const FIGHT_TABLE_QUERY = `
query ($code: String!, $fightID: Int!, $start: Float!, $end: Float!) {
  reportData { report(code: $code) {
    augTable: table(dataType: DamageDone, sourceClass: "Evoker", fightIDs: [$fightID], startTime: $start, endTime: $end)
    fullTable: table(dataType: DamageDone, fightIDs: [$fightID], startTime: $start, endTime: $end)
    combatantInfo: events(dataType: CombatantInfo, fightIDs: [$fightID], startTime: $start, endTime: $end) { data }
  }}
}`;

function makeAugSourceQuery(augActorIds) {
  const fragments = augActorIds
    .map((id) => `aug_${id}: table(dataType: DamageDone, sourceID: ${id}, fightIDs: [$fightID], startTime: $start, endTime: $end, viewBy: Source)`)
    .join("\n      ");
  return `query ($code: String!, $fightID: Int!, $start: Float!, $end: Float!) {
  reportData { report(code: $code) { ${fragments} } }
}`;
}

// ---------------------------------------------------------------------------
// Processed codes tracker — persisted so re-runs skip already-done reports
// ---------------------------------------------------------------------------

async function loadProcessedCodes() {
  try {
    return new Set(JSON.parse(await readFile(PROCESSED_PATH, "utf-8")));
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

async function saveProcessedCodes(codes) {
  await writeFile(PROCESSED_PATH, JSON.stringify([...codes], null, 2));
}

// ---------------------------------------------------------------------------
// Discovery — sample across the ranking spectrum
// ---------------------------------------------------------------------------

/**
 * Picks ranking pages weighted toward mid/low percentiles.
 *
 * Given totalPages available, returns a list of page numbers to fetch.
 * Distribution: ~20% top (pages 1-N), ~30% mid, ~50% bottom.
 */
function pickSamplingPages(totalPages, targetSamples, perPage = 100) {
  if (totalPages <= 0) return [];

  // How many pages do we need? Each page yields ~perPage unique reports
  const pagesNeeded = Math.min(
    Math.ceil(targetSamples / perPage),
    totalPages
  );
  if (pagesNeeded >= totalPages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set();

  // Allocate pages across tiers
  const topCount = Math.max(1, Math.round(pagesNeeded * 0.2));
  const midCount = Math.max(1, Math.round(pagesNeeded * 0.3));
  const botCount = Math.max(1, pagesNeeded - topCount - midCount);

  // Top tier: first pages
  const topEnd = Math.max(1, Math.floor(totalPages * 0.2));
  for (const p of spreadPick(1, topEnd, topCount)) pages.add(p);

  // Mid tier: middle pages
  const midStart = topEnd + 1;
  const midEnd = Math.max(midStart, Math.floor(totalPages * 0.6));
  for (const p of spreadPick(midStart, midEnd, midCount)) pages.add(p);

  // Bottom tier: last pages
  const botStart = midEnd + 1;
  for (const p of spreadPick(botStart, totalPages, botCount)) pages.add(p);

  return [...pages].sort((a, b) => a - b);
}

/** Evenly spread `count` picks across [lo, hi] inclusive. */
function spreadPick(lo, hi, count) {
  const range = hi - lo + 1;
  if (range <= 0 || count <= 0) return [];
  if (count >= range) return Array.from({ length: range }, (_, i) => lo + i);
  const step = (range - 1) / (count - 1 || 1);
  const picks = [];
  for (let i = 0; i < count; i++) {
    picks.push(lo + Math.round(i * step));
  }
  return [...new Set(picks)];
}

async function discoverReportCodes(token, encounters, difficulty, targetSamples) {
  const allCodes = new Map(); // code -> { encounterName, page }

  const perEncounter = Math.ceil(targetSamples / encounters.length);

  for (const enc of encounters) {
    console.log(`\n  Probing ${enc.name}...`);

    // Fetch page 1 to learn total page count
    const probe = await gql(token, RANKINGS_QUERY, {
      encounterID: enc.id, page: 1, difficulty, metric: "dps",
    });

    const rankings = probe?.worldData?.encounter?.characterRankings;
    if (!rankings?.rankings?.length) {
      console.log(`    No rankings found`);
      continue;
    }

    // Estimate total pages from the count field
    const totalEntries = rankings.count ?? rankings.rankings.length;
    const perPage = rankings.rankings.length; // usually 100
    const totalPages = Math.ceil(totalEntries / perPage);

    console.log(`    ${totalEntries} total rankings across ~${totalPages} pages`);

    // Collect codes from page 1
    let codesFromEnc = 0;
    for (const entry of rankings.rankings) {
      const code = entry.report?.code ?? entry.reportCode ?? entry.reportID;
      if (!code || code.startsWith("a:")) continue;
      if (!allCodes.has(code)) {
        allCodes.set(code, { encounter: enc.name, page: 1 });
        codesFromEnc++;
      }
    }

    // Sample additional pages across the spectrum
    const pages = pickSamplingPages(totalPages, perEncounter, perPage);
    const remaining = pages.filter((p) => p !== 1); // page 1 already done

    for (const page of remaining) {
      await sleep(300);
      process.stdout.write(`    page ${page}/${totalPages}...`);

      const data = await gql(token, RANKINGS_QUERY, {
        encounterID: enc.id, page, difficulty, metric: "dps",
      });

      const r = data?.worldData?.encounter?.characterRankings;
      if (!r?.rankings?.length) {
        console.log(` empty`);
        continue;
      }

      let newOnPage = 0;
      for (const entry of r.rankings) {
        const code = entry.report?.code ?? entry.reportCode ?? entry.reportID;
        // Skip anonymized reports (prefixed with "a:") — not fetchable
        if (!code || code.startsWith("a:")) continue;
        if (!allCodes.has(code)) {
          allCodes.set(code, { encounter: enc.name, page });
          newOnPage++;
          codesFromEnc++;
        }
      }
      console.log(` +${newOnPage} new (${allCodes.size} total)`);
    }

    console.log(`    ${codesFromEnc} unique codes from ${enc.name}`);
  }

  return allCodes;
}

// ---------------------------------------------------------------------------
// Report processing (mirrors aug_data.mjs run() but quieter)
// ---------------------------------------------------------------------------

function primaryStatForClass(className) {
  switch (className) {
    case "Mage": case "Warlock": case "Priest": case "Evoker":
      return "intellect";
    case "Hunter": case "Rogue": case "Monk": case "Demon Hunter":
      return "agility";
    case "Warrior": case "Death Knight": case "Paladin":
      return "strength";
    default:
      return null;
  }
}

function getPrimaryStat(stats, className) {
  const fixed = primaryStatForClass(className);
  if (fixed) return stats[fixed] ?? 0;
  return Math.max(stats.intellect ?? 0, stats.agility ?? 0, stats.strength ?? 0);
}

async function processReport(code, token) {
  const data = await gql(token, REPORT_QUERY, { code }, { exitOnError: false });
  if (!data) return null;

  const report = data.reportData.report;
  if (!report) return null;

  const actors = new Map();
  for (const a of report.masterData.actors) actors.set(a.id, a);

  const fights = report.fights;
  if (!fights?.length) return null;

  const fightResults = [];

  for (const fight of fights) {
    const fdata = await gql(token, FIGHT_TABLE_QUERY, {
      code, fightID: fight.id,
      start: fight.startTime, end: fight.endTime,
    }, { exitOnError: false });

    if (!fdata) continue;

    const freport = fdata.reportData.report;
    const allEvokerEntries = freport.augTable?.data?.entries ?? [];
    const fullEntries = freport.fullTable?.data?.entries ?? [];

    const augEntries = allEvokerEntries.filter((e) =>
      (e.icon ?? "").includes("Augmentation")
    );
    if (!augEntries.length) continue;

    const raidTotal = fullEntries.reduce((s, e) => s + (e.total ?? 0), 0);

    // CombatantInfo
    const combatantEvents = freport.combatantInfo?.data ?? [];
    const playerStats = {};
    for (const evt of combatantEvents) {
      const actor = actors.get(evt.sourceID);
      playerStats[evt.sourceID] = {
        name: actor?.name ?? `Actor#${evt.sourceID}`,
        class: actor?.subType ?? null,
        intellect: evt.intellect ?? 0,
        strength: evt.strength ?? 0,
        agility: evt.agility ?? 0,
        stamina: evt.stamina ?? 0,
        critMelee: evt.critMelee ?? 0,
        critSpell: evt.critSpell ?? 0,
        haste: evt.haste ?? 0,
        mastery: evt.mastery ?? 0,
        versatilityDamageDone: evt.versatilityDamageDone ?? 0,
        ilvl: evt.ilvl ?? 0,
      };
    }

    // Per-Aug source breakdown
    const augActorIds = augEntries.map((e) => e.id);
    let augSourceBreakdown = {};

    if (augActorIds.length) {
      const srcData = await gql(token, makeAugSourceQuery(augActorIds), {
        code, fightID: fight.id,
        start: fight.startTime, end: fight.endTime,
      }, { exitOnError: false });

      if (srcData) {
        const srcReport = srcData.reportData.report;
        for (const augId of augActorIds) {
          augSourceBreakdown[augId] = srcReport[`aug_${augId}`]?.data?.entries ?? [];
        }
      }
    }

    fightResults.push({
      id: fight.id,
      name: fight.name,
      difficulty: fight.difficulty,
      kill: fight.kill,
      raidTotal,
      playerStats,
      augActorIds,
      augSourceBreakdown,
      augEntries,
      allEntries: fullEntries,
    });
  }

  return fightResults.length ? fightResults : null;
}

// ---------------------------------------------------------------------------
// Scaling (same as aug_data.mjs)
// ---------------------------------------------------------------------------

function accumulateBuckets(fightResults, existing = {}) {
  const specBucket = {};
  for (const [k, v] of Object.entries(existing)) specBucket[k] = { ...v };

  for (const fr of fightResults) {
    if (!fr.augSourceBreakdown || !fr.playerStats) continue;

    const augInts = [];
    for (const augId of fr.augActorIds) {
      const s = fr.playerStats[augId];
      if (s) augInts.push(s.intellect);
    }
    if (!augInts.length) continue;
    const avgAugInt = augInts.reduce((a, b) => a + b, 0) / augInts.length;
    const ebonGrant = avgAugInt * EBON_MIGHT_COEFF;

    const dmgByName = {};
    const specByName = {};
    for (const e of fr.allEntries) {
      dmgByName[e.name] = e.total ?? 0;
      specByName[e.name] = e.icon ?? "Unknown";
    }

    for (const augId of fr.augActorIds) {
      const sources = fr.augSourceBreakdown[augId] ?? [];
      for (const src of sources) {
        const playerName = src.name;
        const attributed = src.total ?? 0;
        if (attributed <= 0) continue;

        const totalDmg = dmgByName[playerName];
        if (!totalDmg || totalDmg <= 0) continue;

        const pStats = Object.values(fr.playerStats).find(
          (p) => p.name === playerName
        );
        if (!pStats) continue;

        const className = pStats.class;
        const primary = getPrimaryStat(pStats, className);
        if (!primary || primary <= 0) continue;

        const specIcon = specByName[playerName] ?? `${className}-Unknown`;
        const statIncreasePct = (ebonGrant / primary) * 100;
        const dmgIncreasePct = (attributed / totalDmg) * 100;
        const elasticity = dmgIncreasePct / statIncreasePct;

        if (!specBucket[specIcon]) {
          specBucket[specIcon] = {
            totalDamage: 0, totalAttributed: 0,
            weightedElasticitySum: 0, totalWeight: 0, samples: 0,
          };
        }
        const b = specBucket[specIcon];
        b.totalDamage += totalDmg;
        b.totalAttributed += attributed;
        b.weightedElasticitySum += elasticity * totalDmg;
        b.totalWeight += totalDmg;
        b.samples += 1;
      }
    }
  }
  return specBucket;
}

function finalizeScaling(specBucket) {
  const scaling = {};
  for (const [spec, b] of Object.entries(specBucket)) {
    const avgElasticity = b.totalWeight ? b.weightedElasticitySum / b.totalWeight : 0;
    scaling[spec] = {
      spec,
      avgElasticity: Math.round(avgElasticity * 10000) / 10000,
      avgAttributionPct: b.totalDamage > 0
        ? Math.round((b.totalAttributed / b.totalDamage) * 10000) / 100 : 0,
      totalDamage: b.totalDamage,
      totalAttributed: b.totalAttributed,
      samples: b.samples,
    };
  }
  return scaling;
}

async function loadExistingBuckets() {
  try {
    const parsed = JSON.parse(await readFile(BUCKETS_PATH, "utf-8"));
    const total = Object.values(parsed).reduce((s, b) => s + (b.samples ?? 0), 0);
    console.log(`Loaded existing buckets: ${total} samples across ${Object.keys(parsed).length} specs`);
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot load ${BUCKETS_PATH}: ${err.message} — fix or remove manually`);
  }
}

async function saveBuckets(buckets, prevSamples) {
  const totalSamples = Object.values(buckets).reduce((s, b) => s + b.samples, 0);

  if (totalSamples < prevSamples) {
    console.error(`BUG: samples decreased ${prevSamples} -> ${totalSamples}. NOT saving.`);
    return;
  }

  if (prevSamples > 0) {
    try { await copyFile(BUCKETS_PATH, BUCKETS_PATH.replace(".json", ".backup.json")); }
    catch { /* best-effort */ }
  }

  await writeFile(BUCKETS_PATH, JSON.stringify(buckets, null, 2));
  await writeFile(AGG_PATH, JSON.stringify(finalizeScaling(buckets), null, 2));
}

function printScalingSummary(buckets) {
  const scaling = finalizeScaling(buckets);
  const sorted = Object.values(scaling).sort((a, b) => b.avgElasticity - a.avgElasticity);
  const totalSamples = sorted.reduce((s, v) => s + v.samples, 0);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Spec Scaling (${totalSamples} total samples)`);
  console.log("=".repeat(70));
  console.log(`  ${pad("Spec", 28)}${pad("Elasticity", 12, true)}${pad("Attr %", 10, true)}${pad("Samples", 10, true)}`);
  console.log(`  ${"-".repeat(28)} ${"-".repeat(12)} ${"-".repeat(10)} ${"-".repeat(10)}`);
  for (const s of sorted) {
    console.log(
      `  ${pad(s.spec, 28)}${pad(s.avgElasticity.toFixed(4), 12, true)}${pad(s.avgAttributionPct.toFixed(1) + "%", 10, true)}${pad(String(s.samples), 10, true)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      zone: { type: "string", short: "z" },
      difficulty: { type: "string", short: "d", default: "4" },
      samples: { type: "string", short: "s", default: "200" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log("Usage: node pipeline.mjs [-z zoneID] [-d difficulty] [-s targetReports]");
    console.log("\nFully automated: discovers reports across ranking spectrum, processes them,");
    console.log("and merges into aggregate_scaling.json. Survives rate limits — leave it running.");
    process.exit(0);
  }

  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Set WCL_CLIENT_ID and WCL_CLIENT_SECRET in .env");
    process.exit(1);
  }

  const difficulty = parseInt(values.difficulty, 10);
  const targetSamples = parseInt(values.samples, 10);
  const diffLabel = DIFF_MAP[difficulty] ?? `diff=${difficulty}`;

  await mkdir(DATA_DIR, { recursive: true });

  console.log(`[${ts()}] Authenticating...`);
  const token = await getAccessToken(clientId, clientSecret);

  // Auto-detect zone — pick the highest zone ID that's an actual raid
  // (skip "Complete Raids" composites 500+, Mythic+ zones, Delves, etc.)
  let zoneID;
  if (values.zone) {
    zoneID = parseInt(values.zone, 10);
  } else {
    const data = await gql(token, ZONE_LIST_QUERY, {}, { exitOnError: true });
    let best = null;
    const skip = /complete raids|mythic\+|delves|challenge|torghast|mage tower|beta/i;
    for (const exp of data.worldData.expansions) {
      for (const z of exp.zones) {
        if (skip.test(z.name)) continue;
        if (z.id >= 500) continue; // composite zone IDs
        if (!best || z.id > best.id) best = { ...z, expName: exp.name };
      }
    }
    if (!best) { console.error("No raid zones found"); process.exit(1); }
    zoneID = best.id;
    console.log(`Zone: ${best.name} (${best.expName}, id=${zoneID})`);
  }

  const { zoneName, encounters } = await (async () => {
    const d = await gql(token, ENCOUNTER_LIST_QUERY, { zoneID }, { exitOnError: true });
    const z = d.worldData.zone;
    return { zoneName: z.name, encounters: z.encounters };
  })();

  console.log(`${zoneName} — ${diffLabel} — ${encounters.length} encounters`);
  console.log(`Target: ~${targetSamples} reports, sampled bottom-heavy across rankings\n`);

  // Load state
  const processedCodes = await loadProcessedCodes();
  const existingBuckets = await loadExistingBuckets();
  const prevSamples = Object.values(existingBuckets).reduce((s, b) => s + b.samples, 0);

  console.log(`Already processed: ${processedCodes.size} reports\n`);

  // Phase 1: Discover report codes
  console.log(`${"=".repeat(70)}\n  Phase 1: Discovering reports\n${"=".repeat(70)}`);

  const discoveredCodes = await discoverReportCodes(token, encounters, difficulty, targetSamples);
  const newCodes = [...discoveredCodes.keys()].filter((c) => !processedCodes.has(c));

  console.log(`\nDiscovered ${discoveredCodes.size} total, ${newCodes.length} not yet processed`);

  if (!newCodes.length) {
    console.log("\nNothing new to process. Run with more --samples or wait for new logs.");
    printScalingSummary(existingBuckets);
    return;
  }

  // Phase 2: Process reports and merge incrementally
  console.log(`\n${"=".repeat(70)}\n  Phase 2: Processing ${newCodes.length} reports\n${"=".repeat(70)}`);

  let currentBuckets = existingBuckets;
  let reportsProcessed = 0;
  let reportsSkipped = 0;
  let fightsProcessed = 0;

  for (let i = 0; i < newCodes.length; i++) {
    const code = newCodes[i];
    const meta = discoveredCodes.get(code);
    const progress = `[${i + 1}/${newCodes.length}]`;

    process.stdout.write(`${progress} ${code} (${meta?.encounter ?? "?"})... `);

    try {
      const fightResults = await processReport(code, token);

      if (fightResults?.length) {
        currentBuckets = accumulateBuckets(fightResults, currentBuckets);
        fightsProcessed += fightResults.length;
        reportsProcessed++;
        console.log(`${fightResults.length} fights`);
      } else {
        reportsSkipped++;
        console.log(`skipped (no aug data)`);
      }

      // Mark as processed regardless — don't re-attempt reports with no data
      processedCodes.add(code);

      // Persist every 5 reports to avoid losing progress
      const done = reportsProcessed + reportsSkipped;
      if (done % 5 === 0) {
        await saveBuckets(currentBuckets, prevSamples);
        await saveProcessedCodes(processedCodes);
      }
      // Rate limit status every 10 reports
      if (done % 10 === 0 && rateLimit.lastChecked) {
        const pct = ((rateLimit.pointsSpent / rateLimit.limitPerHour) * 100).toFixed(0);
        const resetMin = (rateLimit.resetInNow / 60).toFixed(1);
        console.log(`  [rate] ${pct}% used (${rateLimit.pointsSpent}/${rateLimit.limitPerHour} pts) — resets in ${resetMin}m`);
      }
    } catch (err) {
      console.log(`error: ${err.message.slice(0, 100)}`);
      reportsSkipped++;
      // Don't mark as processed — retry next run
    }
  }

  // Final save
  await saveBuckets(currentBuckets, prevSamples);
  await saveProcessedCodes(processedCodes);

  const totalSamples = Object.values(currentBuckets).reduce((s, b) => s + b.samples, 0);
  const newSamples = totalSamples - prevSamples;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Pipeline complete`);
  console.log(`  Reports: ${reportsProcessed} processed, ${reportsSkipped} skipped`);
  console.log(`  Fights: ${fightsProcessed}`);
  console.log(`  Samples: ${totalSamples} total (+${newSamples} new)`);
  console.log("=".repeat(70));

  printScalingSummary(currentBuckets);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
