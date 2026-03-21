/**
 * Build compact summary JSONs from per-report data for the web dashboard.
 *
 * Reads data/aggregate_scaling.json and all data/<code>/report.json files,
 * produces small summary files in data/summaries/.
 *
 * Usage: node build-summary.mjs
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const SUMMARIES_DIR = join(DATA_DIR, "summaries");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJSON(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(SUMMARIES_DIR, { recursive: true });

  // 1. Copy aggregate scaling as-is
  let specScaling = {};
  try {
    specScaling = await readJSON(join(DATA_DIR, "aggregate_scaling.json"));
  } catch {
    console.warn("No aggregate_scaling.json found — spec scaling will be empty");
  }
  await writeJSON(join(SUMMARIES_DIR, "spec_scaling.json"), specScaling);

  // 2. Read all report.json files
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const reportDirs = entries.filter(
    (e) => e.isDirectory() && e.name !== "summaries"
  );

  // Accumulators
  // encounterID -> { name, kills, wipes, totalDuration, totalRaidDmg, totalAugAttr, totalFights, augCounts }
  const encSummary = {};
  // encounterID -> specIcon -> { totalAttr, totalDmg, totalDuration, count }
  const encSpecMatrix = {};

  let totalReports = 0;
  let totalFights = 0;
  let totalSamples = Object.values(specScaling).reduce(
    (s, v) => s + (v.samples ?? 0),
    0
  );

  for (const dir of reportDirs) {
    const reportPath = join(DATA_DIR, dir.name, "report.json");
    let report;
    try {
      report = await readJSON(reportPath);
    } catch {
      continue;
    }
    totalReports++;

    for (const fight of report.fights ?? []) {
      const encId = fight.encounterID;
      if (!encId) continue;
      totalFights++;

      const duration = (fight.duration ?? fight.endTime - fight.startTime) / 1000;
      if (duration <= 0) continue;

      const raidTotal = fight.raidTotal ?? 0;

      // Sum aug attributed damage
      let augAttr = 0;
      const augCount = (fight.augEntries ?? []).length;
      for (const e of fight.augEntries ?? []) {
        augAttr += e.total ?? 0;
      }

      // Encounter summary accumulator
      if (!encSummary[encId]) {
        encSummary[encId] = {
          encounterID: encId,
          name: fight.name ?? "Unknown",
          kills: 0,
          wipes: 0,
          totalDuration: 0,
          totalRaidDmg: 0,
          totalAugAttr: 0,
          totalFights: 0,
          augCounts: 0,
        };
      }
      const es = encSummary[encId];
      es.totalFights++;
      es.totalDuration += duration;
      es.totalRaidDmg += raidTotal;
      es.totalAugAttr += augAttr;
      es.augCounts += augCount;
      if (fight.kill) es.kills++;
      else es.wipes++;

      // Per-spec prescience matrix — from augSourceBreakdown
      const dmgByName = {};
      const specByName = {};
      for (const e of fight.allEntries ?? []) {
        dmgByName[e.name] = e.total ?? 0;
        specByName[e.name] = e.icon ?? "Unknown";
      }

      if (!encSpecMatrix[encId]) encSpecMatrix[encId] = {};
      const seen = new Set();

      for (const augId of fight.augActorIds ?? []) {
        const sources = fight.augSourceBreakdown?.[augId] ?? [];
        for (const src of sources) {
          // Skip pets
          if (src.type === "Pet") continue;
          const spec = specByName[src.name] || src.icon || "Unknown";
          // Skip self-attribution
          if (spec.includes("Augmentation")) continue;

          const key = src.name + "|" + fight.id;
          if (seen.has(key)) continue;
          seen.add(key);

          const attr = src.total ?? 0;
          const total = dmgByName[src.name] ?? 0;
          if (attr <= 0 || total <= 0) continue;

          if (!encSpecMatrix[encId][spec]) {
            encSpecMatrix[encId][spec] = {
              totalAttr: 0,
              totalDmg: 0,
              totalDuration: 0,
              count: 0,
            };
          }
          const sm = encSpecMatrix[encId][spec];
          sm.totalAttr += attr;
          sm.totalDmg += total;
          sm.totalDuration += duration;
          sm.count++;
        }
      }
    }
  }

  // 3. Finalize encounter_summary.json — filter to encounters with >= 5 fights
  const encounterSummary = {};
  for (const [id, es] of Object.entries(encSummary)) {
    if (es.totalFights < 5) continue;
    const avgDur = es.totalDuration / es.totalFights;
    encounterSummary[id] = {
      encounterID: es.encounterID,
      name: es.name,
      kills: es.kills,
      wipes: es.wipes,
      totalFights: es.totalFights,
      avgDurationSec: Math.round(avgDur),
      avgRaidTotal: Math.round(es.totalRaidDmg / es.totalFights),
      avgRaidDPS: Math.round(es.totalRaidDmg / es.totalDuration),
      avgAugAttributed: Math.round(es.totalAugAttr / es.totalFights),
      avgAugAttributedPct:
        es.totalRaidDmg > 0
          ? Math.round((es.totalAugAttr / es.totalRaidDmg) * 10000) / 100
          : 0,
      avgAugDPS: Math.round(es.totalAugAttr / es.totalDuration),
      avgAugCount:
        Math.round((es.augCounts / es.totalFights) * 10) / 10,
    };
  }
  await writeJSON(join(SUMMARIES_DIR, "encounter_summary.json"), encounterSummary);

  // 4. Finalize encounter_spec_matrix.json
  const encounterSpecMatrix = {};
  for (const [id, specs] of Object.entries(encSpecMatrix)) {
    if (!encounterSummary[id]) continue; // skip encounters filtered out above
    const specList = Object.entries(specs)
      .map(([spec, d]) => ({
        spec,
        avgAttributed: Math.round(d.totalAttr / d.count),
        avgAttributedDPS: Math.round(d.totalAttr / d.totalDuration),
        avgTotalDmg: Math.round(d.totalDmg / d.count),
        avgAttributedPct:
          d.totalDmg > 0
            ? Math.round((d.totalAttr / d.totalDmg) * 10000) / 100
            : 0,
        count: d.count,
      }))
      .sort((a, b) => b.avgAttributed - a.avgAttributed);

    encounterSpecMatrix[id] = {
      encounterID: parseInt(id),
      name: encounterSummary[id].name,
      specs: specList,
    };
  }
  await writeJSON(
    join(SUMMARIES_DIR, "encounter_spec_matrix.json"),
    encounterSpecMatrix
  );

  // 5. Meta
  const meta = {
    generatedAt: new Date().toISOString(),
    totalReports,
    totalFights,
    totalSamples,
    encounterCount: Object.keys(encounterSummary).length,
  };
  await writeJSON(join(SUMMARIES_DIR, "meta.json"), meta);

  console.log(`Summaries built:`);
  console.log(`  Reports: ${totalReports}`);
  console.log(`  Fights: ${totalFights}`);
  console.log(`  Encounters: ${meta.encounterCount}`);
  console.log(`  Specs: ${Object.keys(specScaling).length}`);
  console.log(`  Samples: ${totalSamples}`);
  console.log(`  Output: ${SUMMARIES_DIR}`);
}

main().catch((err) => {
  console.error(`build-summary failed: ${err.message}`);
  process.exit(1);
});
