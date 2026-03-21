/**
 * Warcraft Logs Augmentation Evoker Attribution Data Puller
 *
 * Authenticates with the WCL v2 GraphQL API, fetches fight metadata
 * and Augmentation Evoker damage attribution for a given report code.
 *
 * Setup:
 *   1. Register an API client at https://www.warcraftlogs.com/api/clients
 *   2. Set WCL_CLIENT_ID and WCL_CLIENT_SECRET in a .env file
 *   3. npm install dotenv
 *
 * Usage:
 *   node aug_data.mjs <report-code-or-url> [-f 3,5,7]
 */

import { config } from "dotenv";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

const DATA_DIR = join(__dirname, "data");
const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_URL = "https://www.warcraftlogs.com/api/v2/client";

// Ebon Might base coefficient — fraction of Aug's Int granted to each target.
// TWW S2 baseline is ~20.8%.  Adjust if patch changes it.
const EBON_MIGHT_COEFF = 0.208;

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
  const data = await resp.json();
  return data.access_token;
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

async function gql(
  token,
  query,
  variables = {},
  { exitOnError = true } = {}
) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`API error: ${resp.status} ${await resp.text()}`);
  }
  const body = await resp.json();
  if (body.errors) {
    for (const err of body.errors) {
      console.error(`  GraphQL error: ${err.message}`);
    }
    if (exitOnError) process.exit(1);
    return null;
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const REPORT_QUERY = `
query ($code: String!) {
  reportData {
    report(code: $code) {
      title
      startTime
      endTime
      masterData {
        actors(type: "Player") {
          id
          name
          type
          subType
          server
        }
      }
      fights(killType: Encounters) {
        id
        encounterID
        name
        kill
        startTime
        endTime
        difficulty
        size
        bossPercentage
        friendlyPlayers
      }
    }
  }
}
`;

const FIGHT_TABLE_QUERY = `
query ($code: String!, $fightID: Int!, $start: Float!, $end: Float!) {
  reportData {
    report(code: $code) {
      augTable: table(
        dataType: DamageDone
        sourceClass: "Evoker"
        fightIDs: [$fightID]
        startTime: $start
        endTime: $end
      )
      fullTable: table(
        dataType: DamageDone
        fightIDs: [$fightID]
        startTime: $start
        endTime: $end
      )
      combatantInfo: events(
        dataType: CombatantInfo
        fightIDs: [$fightID]
        startTime: $start
        endTime: $end
      ) {
        data
      }
    }
  }
}
`;

// Per-Aug Evoker: get damage broken down by contributing source player.
// We build this dynamically because sourceID is only known at runtime.
function makeAugSourceQuery(augActorIds) {
  const fragments = augActorIds
    .map(
      (id) => `
      aug_${id}: table(
        dataType: DamageDone
        sourceID: ${id}
        fightIDs: [$fightID]
        startTime: $start
        endTime: $end
        viewBy: Source
      )`
    )
    .join("\n");

  return `
query ($code: String!, $fightID: Int!, $start: Float!, $end: Float!) {
  reportData {
    report(code: $code) {
      ${fragments}
    }
  }
}
`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DIFF_MAP = { 3: "Normal", 4: "Heroic", 5: "Mythic" };

function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.floor(n));
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function pad(str, len, right = false) {
  if (right) return String(str).padStart(len);
  return String(str).padEnd(len);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function extractCode(raw) {
  const m = raw.match(/reports\/([A-Za-z0-9]+)/);
  return m ? m[1] : raw.trim().split("#")[0].split("?")[0];
}

function printFightHeader(fight) {
  const diff = DIFF_MAP[fight.difficulty] ?? `diff=${fight.difficulty}`;
  const outcome = fight.kill
    ? "Kill"
    : `Wipe (${((fight.bossPercentage ?? 0) / 100).toFixed(1)}%)`;
  const duration = fmtTime(fight.endTime - fight.startTime);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${fight.name} (${diff}) — ${outcome} — ${duration}`);
  console.log("=".repeat(70));
}

function printAugBreakdown(augEntries, raidTotal) {
  if (!augEntries.length) {
    console.log("  No Augmentation Evoker data for this fight.");
    return;
  }

  for (const entry of augEntries) {
    const total = entry.total ?? 0;
    const pct = raidTotal ? ((total / raidTotal) * 100).toFixed(1) : "0.0";

    console.log(
      `\n  ${entry.name} (Augmentation) — ${fmtNum(total)} total (${pct}% of raid)`
    );

    const abilities = [...(entry.abilities ?? [])].sort(
      (a, b) => (b.total ?? 0) - (a.total ?? 0)
    );
    if (abilities.length) {
      console.log(
        `  ${pad("Ability", 35)}${pad("Damage", 12, true)}${pad("% of player", 12, true)}`
      );
      console.log(
        `  ${"-".repeat(35)} ${"-".repeat(12)} ${"-".repeat(12)}`
      );
      for (const ab of abilities) {
        const abTotal = ab.total ?? 0;
        const abPct = total ? ((abTotal / total) * 100).toFixed(1) : "0.0";
        console.log(
          `  ${pad(ab.name, 35)}${pad(fmtNum(abTotal), 12, true)}${pad(abPct + "%", 12, true)}`
        );
      }
    }

    const targets = [...(entry.targets ?? [])].sort(
      (a, b) => (b.total ?? 0) - (a.total ?? 0)
    );
    if (targets.length) {
      console.log(`\n  Damage by target:`);
      for (const t of targets.slice(0, 10)) {
        console.log(
          `    ${pad(t.name, 30)}${pad(fmtNum(t.total ?? 0), 12, true)}`
        );
      }
    }
  }
}

/** Determine primary stat for a class (from masterData subType which is class name). */
function primaryStatForClass(className) {
  switch (className) {
    case "Mage":
    case "Warlock":
    case "Priest":
    case "Evoker":
      return "intellect";
    case "Hunter":
    case "Rogue":
    case "Monk":
    case "Demon Hunter":
      return "agility";
    case "Warrior":
    case "Death Knight":
    case "Paladin":
      return "strength";
    case "Druid":
    case "Shaman":
      // could be either — pick the higher one at runtime
      return null;
    default:
      return null;
  }
}

function getPrimaryStat(stats, className) {
  const fixed = primaryStatForClass(className);
  if (fixed) return stats[fixed] ?? 0;
  // Hybrid — take whichever is higher
  return Math.max(stats.intellect ?? 0, stats.agility ?? 0, stats.strength ?? 0);
}

// ---------------------------------------------------------------------------
// Scaling computation
// ---------------------------------------------------------------------------

/**
 * For each spec in the raid, compute the empirical damage elasticity to
 * primary stat:  "if primary stat increases by 1 %, damage increases by X %".
 *
 * Method:
 *   Ebon Might grants each target  augInt * EBON_MIGHT_COEFF  extra primary.
 *   stat_increase_pct  = (augInt * coeff) / targetPrimary * 100
 *   damage_increase_pct = attributedDmg / targetTotalDmg * 100
 *   elasticity = damage_increase_pct / stat_increase_pct
 *
 *   We accumulate raw bucket values so they can be persisted and merged
 *   across multiple runs, then finalized into averages at display time.
 */

/** Accumulate fight results into raw spec buckets (additive / mergeable). */
function accumulateBuckets(fightResults, existing = {}) {
  // Deep-clone existing so we don't mutate the input
  const specBucket = {};
  for (const [k, v] of Object.entries(existing)) {
    specBucket[k] = { ...v };
  }

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
            totalDamage: 0,
            totalAttributed: 0,
            weightedElasticitySum: 0,
            totalWeight: 0,
            samples: 0,
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

/** Finalize raw buckets into display-ready scaling objects. */
function finalizeScaling(specBucket) {
  const scaling = {};
  for (const [spec, b] of Object.entries(specBucket)) {
    const avgElasticity = b.totalWeight
      ? b.weightedElasticitySum / b.totalWeight
      : 0;
    scaling[spec] = {
      spec,
      avgElasticity: Math.round(avgElasticity * 10000) / 10000,
      avgAttributionPct:
        b.totalDamage > 0
          ? Math.round((b.totalAttributed / b.totalDamage) * 10000) / 100
          : 0,
      totalDamage: b.totalDamage,
      totalAttributed: b.totalAttributed,
      samples: b.samples,
    };
  }
  return scaling;
}

/** Convenience: accumulate + finalize in one step (used for per-report output). */
function computeSpecScaling(fightResults) {
  return finalizeScaling(accumulateBuckets(fightResults));
}

const AGG_PATH = join(DATA_DIR, "aggregate_scaling.json");
const BUCKETS_PATH = join(DATA_DIR, "aggregate_buckets.json");

async function loadExistingBuckets() {
  try {
    const raw = await readFile(BUCKETS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const total = Object.values(parsed).reduce((s, b) => s + (b.samples ?? 0), 0);
    console.log(`  Loaded existing buckets: ${total} samples across ${Object.keys(parsed).length} specs`);
    return parsed;
  } catch (err) {
    // File genuinely missing → start fresh
    if (err.code === "ENOENT") return {};
    // Anything else (corrupt JSON, permission denied, etc.) → refuse to overwrite
    throw new Error(
      `Failed to load existing buckets from ${BUCKETS_PATH}: ${err.message}\n` +
      `Refusing to continue — fix or remove the file manually to avoid data loss.`
    );
  }
}

function printSpecScaling(scaling) {
  const sorted = Object.values(scaling).sort(
    (a, b) => b.avgElasticity - a.avgElasticity
  );

  console.log(`\n${"=".repeat(70)}`);
  console.log("  Spec Scaling — damage % gained per 1% primary stat increase");
  console.log("=".repeat(70));
  console.log(
    `  ${pad("Spec", 28)}${pad("Elasticity", 12, true)}${pad("Attr %", 10, true)}${pad("Samples", 10, true)}`
  );
  console.log(
    `  ${"-".repeat(28)} ${"-".repeat(12)} ${"-".repeat(10)} ${"-".repeat(10)}`
  );
  for (const s of sorted) {
    console.log(
      `  ${pad(s.spec, 28)}${pad(s.avgElasticity.toFixed(4), 12, true)}${pad(s.avgAttributionPct.toFixed(1) + "%", 10, true)}${pad(String(s.samples), 10, true)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function run(code, token, fightIds) {
  console.log(`Fetching report ${code} ...`);
  const data = await gql(token, REPORT_QUERY, { code });
  const report = data.reportData.report;

  // Build actor lookup — masterData subType is the CLASS (e.g. "Evoker"),
  // not the spec.  We cannot identify Aug vs Deva/Pres from masterData alone.
  const actors = new Map();
  for (const a of report.masterData.actors) {
    actors.set(a.id, a);
  }

  console.log(`Report: ${report.title}`);

  let fights = report.fights;
  if (fightIds) {
    fights = fights.filter((f) => fightIds.includes(f.id));
  }
  if (!fights.length) {
    console.log("No matching fights found.");
    return;
  }

  console.log(`${fights.length} fight(s) to process\n`);

  // Prepare output directory
  const reportDir = join(DATA_DIR, code);
  await mkdir(reportDir, { recursive: true });

  // We'll discover Aug Evokers from the icon field in augEntries, since
  // masterData only has the class, not the spec.
  const discoveredAugs = new Map(); // actorId -> name

  const fightResults = [];

  for (const fight of fights) {
    printFightHeader(fight);

    // --- Phase 1: damage tables + combatant info ---
    const fdata = await gql(
      token,
      FIGHT_TABLE_QUERY,
      {
        code,
        fightID: fight.id,
        start: fight.startTime,
        end: fight.endTime,
      },
      { exitOnError: false }
    );

    if (!fdata) {
      console.log("  Skipped (data unavailable).");
      continue;
    }

    const freport = fdata.reportData.report;

    const augTable = freport.augTable ?? {};
    const fullTable = freport.fullTable ?? {};

    const allEvokerEntries = augTable?.data?.entries ?? [];
    const fullEntries = fullTable?.data?.entries ?? [];

    // Filter to Augmentation spec using the icon field
    const augEntries = allEvokerEntries.filter((e) =>
      (e.icon ?? "").includes("Augmentation")
    );

    // Track discovered Aug Evokers by their actor id + name
    for (const e of augEntries) {
      if (!discoveredAugs.has(e.id)) {
        discoveredAugs.set(e.id, e.name);
      }
    }

    const raidTotal = fullEntries.reduce((s, e) => s + (e.total ?? 0), 0);
    console.log(`  Raid total damage: ${fmtNum(raidTotal)}`);

    printAugBreakdown(augEntries, raidTotal);

    // Parse CombatantInfo events
    const combatantEvents = freport.combatantInfo?.data ?? [];
    const playerStats = {};
    for (const evt of combatantEvents) {
      const actor = actors.get(evt.sourceID);
      const name = actor?.name ?? `Actor#${evt.sourceID}`;
      playerStats[evt.sourceID] = {
        name,
        class: actor?.subType ?? null, // masterData subType = class name
        intellect: evt.intellect ?? 0,
        strength: evt.strength ?? 0,
        agility: evt.agility ?? 0,
        stamina: evt.stamina ?? 0,
        critMelee: evt.critMelee ?? 0,
        critSpell: evt.critSpell ?? 0,
        haste: evt.haste ?? 0,
        mastery: evt.mastery ?? 0,
        versatilityDamageDone: evt.versatilityDamageDone ?? 0,
        versatilityHealingDone: evt.versatilityHealingDone ?? 0,
        versatilityDamageReduction: evt.versatilityDamageReduction ?? 0,
        ilvl: evt.ilvl ?? 0,
        gear: evt.gear ?? [],
      };
    }

    if (Object.keys(playerStats).length) {
      console.log(
        `  Player stats snapshot: ${Object.keys(playerStats).length} players`
      );
    }

    // --- Phase 2: per-Aug source breakdown (who contributed what) ---
    const augActorIds = augEntries.map((e) => e.id);
    let augSourceBreakdown = {};

    if (augActorIds.length) {
      const srcQuery = makeAugSourceQuery(augActorIds);
      const srcData = await gql(
        token,
        srcQuery,
        {
          code,
          fightID: fight.id,
          start: fight.startTime,
          end: fight.endTime,
        },
        { exitOnError: false }
      );

      if (srcData) {
        const srcReport = srcData.reportData.report;
        for (const augId of augActorIds) {
          const tbl = srcReport[`aug_${augId}`];
          augSourceBreakdown[augId] = tbl?.data?.entries ?? [];
        }
      }

      // Print per-player contribution summary
      for (const augId of augActorIds) {
        const sources = augSourceBreakdown[augId] ?? [];
        if (!sources.length) continue;
        const augName = discoveredAugs.get(augId) ?? `Aug#${augId}`;
        console.log(`\n  ${augName} — damage by contributing player:`);
        const sorted = [...sources].sort(
          (a, b) => (b.total ?? 0) - (a.total ?? 0)
        );
        for (const s of sorted.slice(0, 15)) {
          const spec = (s.icon ?? "").replace("-", " ");
          console.log(
            `    ${pad(s.name, 22)} ${pad(spec, 22)} ${pad(fmtNum(s.total ?? 0), 10, true)}`
          );
        }
      }
    }

    fightResults.push({
      id: fight.id,
      encounterID: fight.encounterID,
      name: fight.name,
      difficulty: fight.difficulty,
      difficultyName: DIFF_MAP[fight.difficulty] ?? `diff=${fight.difficulty}`,
      kill: fight.kill,
      bossPercentage: fight.bossPercentage,
      duration: fight.endTime - fight.startTime,
      startTime: fight.startTime,
      endTime: fight.endTime,
      raidTotal,
      playerStats,
      augActorIds,
      augSourceBreakdown,
      augEntries,
      allEntries: fullEntries,
    });
  }

  // Per-report spec scaling
  const specScaling = computeSpecScaling(fightResults);
  if (Object.keys(specScaling).length) {
    printSpecScaling(specScaling);
  }

  // --- Save ---
  const augEvokerNames = [...discoveredAugs.values()];
  if (augEvokerNames.length) {
    console.log(`\nAug Evoker(s) found: ${augEvokerNames.join(", ")}`);
  }

  const reportOutput = {
    code,
    title: report.title,
    startTime: report.startTime,
    endTime: report.endTime,
    augEvokers: augEvokerNames,
    players: report.masterData.actors,
    specScaling,
    fights: fightResults,
  };

  const reportPath = join(reportDir, "report.json");
  await writeFile(reportPath, JSON.stringify(reportOutput, null, 2));
  console.log(`Saved to ${reportPath}`);

  return fightResults;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fights: { type: "string", short: "f" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !positionals.length) {
    console.log(
      "Usage: node aug_data.mjs <report-code-or-url | reports.txt> [-f fight1,fight2,...]"
    );
    console.log(
      "\nYou can pass a single report code/URL, or a .txt file with one link per line."
    );
    console.log(
      "Set WCL_CLIENT_ID and WCL_CLIENT_SECRET in .env or environment."
    );
    console.log("Register at https://www.warcraftlogs.com/api/clients");
    process.exit(values.help ? 0 : 1);
  }

  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "Error: Set WCL_CLIENT_ID and WCL_CLIENT_SECRET env vars."
    );
    console.error("Register at https://www.warcraftlogs.com/api/clients");
    process.exit(1);
  }

  const fightIds = values.fights
    ? values.fights.split(",").map((s) => parseInt(s.trim(), 10))
    : null;

  // Resolve input — single code/URL or a .txt file with one per line
  const input = positionals[0];
  let codes;

  if (input.endsWith(".txt")) {
    const filePath = resolve(input);
    const content = await readFile(filePath, "utf-8");
    codes = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(extractCode);
    console.log(`Loaded ${codes.length} report(s) from ${filePath}\n`);
  } else {
    codes = [extractCode(input)];
  }

  const token = await getAccessToken(clientId, clientSecret);

  // Process each report, collecting all fight results for cross-report scaling
  const allFightResults = [];

  for (let i = 0; i < codes.length; i++) {
    if (codes.length > 1) {
      console.log(
        `\n${"#".repeat(70)}\n  Report ${i + 1} / ${codes.length}\n${"#".repeat(70)}`
      );
    }

    try {
      const results = await run(codes[i], token, fightIds);
      if (results) allFightResults.push(...results);
    } catch (err) {
      console.error(`\n  Error processing ${codes[i]}: ${err.message}`);
      console.error("  Continuing with next report...\n");
    }
  }

  // Aggregate scaling — merge new results into persisted buckets
  if (allFightResults.length) {
    await mkdir(DATA_DIR, { recursive: true });

    const existingBuckets = await loadExistingBuckets();
    const prevSamples = Object.values(existingBuckets).reduce(
      (s, b) => s + b.samples,
      0
    );

    const mergedBuckets = accumulateBuckets(allFightResults, existingBuckets);
    const totalSamples = Object.values(mergedBuckets).reduce(
      (s, b) => s + b.samples,
      0
    );

    const aggregateScaling = finalizeScaling(mergedBuckets);

    if (Object.keys(aggregateScaling).length) {
      const label = prevSamples
        ? `AGGREGATE SCALING (${totalSamples} total samples, ${totalSamples - prevSamples} new)`
        : `AGGREGATE SCALING (${codes.length} reports, ${allFightResults.length} fights)`;

      console.log(
        `\n${"#".repeat(70)}\n  ${label}\n${"#".repeat(70)}`
      );
      printSpecScaling(aggregateScaling);

      // Safety: never allow sample count to decrease
      if (totalSamples < prevSamples) {
        console.error(
          `\n  BUG: merged samples (${totalSamples}) < previous (${prevSamples}). Refusing to save.`
        );
        console.error("  Existing aggregate_buckets.json left untouched.");
        process.exit(1);
      }

      // Back up existing buckets before overwriting
      if (prevSamples > 0) {
        const backupPath = BUCKETS_PATH.replace(".json", ".backup.json");
        try {
          await copyFile(BUCKETS_PATH, backupPath);
        } catch { /* best-effort */ }
      }

      // Persist raw buckets (for merging on next run) and finalized scaling
      await writeFile(BUCKETS_PATH, JSON.stringify(mergedBuckets, null, 2));
      await writeFile(AGG_PATH, JSON.stringify(aggregateScaling, null, 2));
      console.log(`\nAggregate scaling saved to ${AGG_PATH}`);
    }
  }
}

main();
