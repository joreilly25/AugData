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
// Scaling recomputation — mirrors logic from aug_data.mjs accumulateBuckets
// ---------------------------------------------------------------------------

const EBON_MIGHT_COEFF = 0.208;

function primaryStatForClass(className) {
  switch (className) {
    case "Mage": case "Warlock": case "Priest": case "Evoker": return "intellect";
    case "Hunter": case "Rogue": case "Monk": case "Demon Hunter": return "agility";
    case "Warrior": case "Death Knight": case "Paladin": return "strength";
    default: return null; // Druid, Shaman — pick higher at runtime
  }
}

function getPrimaryStat(stats, className) {
  const fixed = primaryStatForClass(className);
  if (fixed) return stats[fixed] ?? 0;
  return Math.max(stats.intellect ?? 0, stats.agility ?? 0, stats.strength ?? 0);
}

function accumulateScaling(fights, buckets = {}) {
  for (const fr of fights) {
    if (!fr.augSourceBreakdown || !fr.playerStats) continue;

    const augInts = [];
    for (const augId of fr.augActorIds ?? []) {
      const s = fr.playerStats[augId];
      if (s) augInts.push(s.intellect);
    }
    if (!augInts.length) continue;
    const avgAugInt = augInts.reduce((a, b) => a + b, 0) / augInts.length;
    const ebonGrant = avgAugInt * EBON_MIGHT_COEFF;

    const dmgByName = {};
    const specByName = {};
    for (const e of fr.allEntries ?? []) {
      dmgByName[e.name] = e.total ?? 0;
      specByName[e.name] = e.icon ?? "Unknown";
    }

    for (const augId of fr.augActorIds ?? []) {
      const sources = fr.augSourceBreakdown[augId] ?? [];
      for (const src of sources) {
        const attributed = src.total ?? 0;
        if (attributed <= 0) continue;
        // Skip pets and self-attribution (Aug buffing itself is circular)
        if (src.type === "Pet") continue;
        const srcSpec = specByName[src.name] ?? "";
        if (srcSpec.includes("Augmentation")) continue;
        const totalDmg = dmgByName[src.name];
        if (!totalDmg || totalDmg <= 0) continue;
        const pStats = Object.values(fr.playerStats).find((p) => p.name === src.name);
        if (!pStats) continue;
        const primary = getPrimaryStat(pStats, pStats.class);
        if (!primary || primary <= 0) continue;

        const specIcon = specByName[src.name] ?? `${pStats.class}-Unknown`;
        const statIncreasePct = (ebonGrant / primary) * 100;
        const dmgIncreasePct = (attributed / totalDmg) * 100;
        const elasticity = dmgIncreasePct / statIncreasePct;

        if (!buckets[specIcon]) {
          buckets[specIcon] = { totalDamage: 0, totalAttributed: 0, weightedElasticitySum: 0, totalWeight: 0, samples: 0 };
        }
        const b = buckets[specIcon];
        b.totalDamage += totalDmg;
        b.totalAttributed += attributed;
        b.weightedElasticitySum += elasticity * totalDmg;
        b.totalWeight += totalDmg;
        b.samples += 1;
      }
    }
  }
  return buckets;
}

function finalizeScaling(buckets) {
  const scaling = {};
  for (const [spec, b] of Object.entries(buckets)) {
    const avgElasticity = b.totalWeight ? b.weightedElasticitySum / b.totalWeight : 0;
    scaling[spec] = {
      spec,
      avgElasticity: Math.round(avgElasticity * 10000) / 10000,
      avgAttributionPct: b.totalDamage > 0 ? Math.round((b.totalAttributed / b.totalDamage) * 10000) / 100 : 0,
      totalDamage: b.totalDamage,
      totalAttributed: b.totalAttributed,
      samples: b.samples,
    };
  }
  return scaling;
}

// Fallback encounter → instance mapping for data collected before gameZone was added
const INSTANCE_FALLBACK = {
  // Voidspire Citadel (TWW raid)
  3176: "Voidspire Citadel", 3177: "Voidspire Citadel", 3178: "Voidspire Citadel",
  3179: "Voidspire Citadel", 3180: "Voidspire Citadel", 3181: "Voidspire Citadel",
  3306: "Voidspire Citadel",
  // Pit of Saron
  1999: "Pit of Saron", 2000: "Pit of Saron", 2001: "Pit of Saron",
  // Seat of the Triumvirate
  2065: "Seat of the Triumvirate", 2066: "Seat of the Triumvirate",
  2067: "Seat of the Triumvirate", 2068: "Seat of the Triumvirate",
  // Algeth'ar Academy
  2562: "Algeth'ar Academy", 2563: "Algeth'ar Academy",
  2564: "Algeth'ar Academy", 2565: "Algeth'ar Academy",
  // Windrunner Spire
  3056: "Windrunner Spire", 3057: "Windrunner Spire",
  3058: "Windrunner Spire", 3059: "Windrunner Spire",
  // Magisters' Terrace
  3071: "Magisters' Terrace", 3072: "Magisters' Terrace",
  3073: "Magisters' Terrace", 3074: "Magisters' Terrace",
  // Maisara Caverns
  3212: "Maisara Caverns", 3213: "Maisara Caverns", 3214: "Maisara Caverns",
  // Skyreach
  1698: "Skyreach", 1699: "Skyreach", 1700: "Skyreach", 1701: "Skyreach",
  // Nexus-Point Xenas
  3328: "Nexus-Point Xenas", 3332: "Nexus-Point Xenas",
  3333: "Nexus-Point Xenas",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(SUMMARIES_DIR, { recursive: true });

  // 1. Read all report.json files
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const reportDirs = entries.filter(
    (e) => e.isDirectory() && e.name !== "summaries"
  );

  // Accumulators
  const encSummary = {};
  const encSpecMatrix = {};
  // Scaling buckets by content type
  const scalingBuckets = { all: {}, raid: {}, dungeon: {} };
  // Healer stats: { spec → { totalCasts, totalHealing, totalDuration, count } }
  const healerBuckets = { all: {}, raid: {}, dungeon: {} };
  const encHealerBuckets = {}; // per-encounter healer stats

  let totalReports = 0;
  let totalFights = 0;

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
          zoneName: null,
          kills: 0,
          wipes: 0,
          totalDuration: 0,
          totalRaidDmg: 0,
          totalAugAttr: 0,
          totalFights: 0,
          augCounts: 0,
          difficulties: new Set(),
          keystoneLevels: [],
        };
      }
      // Capture zone name from gameZone (added to queries) or fallback
      if (!encSummary[encId].zoneName) {
        encSummary[encId].zoneName =
          fight.gameZone?.name || INSTANCE_FALLBACK[encId] || null;
      }
      const es = encSummary[encId];
      es.totalFights++;
      es.totalDuration += duration;
      es.totalRaidDmg += raidTotal;
      es.totalAugAttr += augAttr;
      es.augCounts += augCount;
      if (fight.difficulty != null) es.difficulties.add(fight.difficulty);
      if (fight.keystoneLevel != null) es.keystoneLevels.push(fight.keystoneLevel);
      if (fight.kill) es.kills++;
      else es.wipes++;

      // Accumulate scaling per content type
      const fightType = [1, 3, 4].includes(fight.difficulty) ? "raid" : "dungeon";
      accumulateScaling([fight], scalingBuckets.all);
      accumulateScaling([fight], scalingBuckets[fightType]);

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

      // Accumulate healer stats from healerStats array (added by pipeline)
      for (const h of fight.healerStats ?? []) {
        if (!h.spec || h.casts <= 0) continue;
        for (const bucket of [healerBuckets.all, healerBuckets[fightType]]) {
          if (!bucket[h.spec]) bucket[h.spec] = { totalCasts: 0, totalHealing: 0, totalDuration: 0, count: 0 };
          bucket[h.spec].totalCasts += h.casts;
          bucket[h.spec].totalHealing += h.healing;
          bucket[h.spec].totalDuration += duration;
          bucket[h.spec].count++;
        }
        if (!encHealerBuckets[encId]) encHealerBuckets[encId] = {};
        if (!encHealerBuckets[encId][h.spec]) {
          encHealerBuckets[encId][h.spec] = { totalCasts: 0, totalHealing: 0, totalDuration: 0, count: 0 };
        }
        const eb = encHealerBuckets[encId][h.spec];
        eb.totalCasts += h.casts;
        eb.totalHealing += h.healing;
        eb.totalDuration += duration;
        eb.count++;
      }
    }
  }

  // 3. Finalize encounter_summary.json — filter to encounters with >= 5 fights
  // Classify encounter type based on difficulty values seen:
  //   Difficulty 1/3/4 = raid (LFR/Normal/Heroic), 5 alone = dungeon, 108 = delve
  function classifyEncounter(diffs) {
    const d = [...diffs];
    if (d.some((v) => v === 1 || v === 3 || v === 4)) return "raid";
    if (d.some((v) => v === 108)) return "delve";
    return "dungeon";
  }

  const encounterSummary = {};
  for (const [id, es] of Object.entries(encSummary)) {
    if (es.totalFights < 5) continue;
    const avgDur = es.totalDuration / es.totalFights;
    encounterSummary[id] = {
      encounterID: es.encounterID,
      name: es.name,
      type: classifyEncounter(es.difficulties),
      zoneName: es.zoneName || "Unknown",
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
      ...(es.keystoneLevels.length > 0 && {
        keystoneMin: Math.min(...es.keystoneLevels),
        keystoneMax: Math.max(...es.keystoneLevels),
        keystoneAvg: Math.round(es.keystoneLevels.reduce((a, b) => a + b, 0) / es.keystoneLevels.length * 10) / 10,
      }),
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

  // 5. Finalize spec scaling — all / raid / dungeon
  const specScaling = {
    all: finalizeScaling(scalingBuckets.all),
    raid: finalizeScaling(scalingBuckets.raid),
    dungeon: finalizeScaling(scalingBuckets.dungeon),
  };
  await writeJSON(join(SUMMARIES_DIR, "spec_scaling.json"), specScaling);

  // 5b. Finalize healer mana pressure stats
  function finalizeHealerBucket(bucket) {
    return Object.entries(bucket)
      .map(([spec, d]) => ({
        spec,
        avgCPM: d.totalDuration > 0 ? Math.round(d.totalCasts / d.totalDuration * 60 * 10) / 10 : 0,
        avgHPS: d.totalDuration > 0 ? Math.round(d.totalHealing / d.totalDuration) : 0,
        avgHealPerCast: d.totalCasts > 0 ? Math.round(d.totalHealing / d.totalCasts) : 0,
        count: d.count,
      }))
      .sort((a, b) => b.avgCPM - a.avgCPM);
  }

  const healerMana = {
    all: finalizeHealerBucket(healerBuckets.all),
    raid: finalizeHealerBucket(healerBuckets.raid),
    dungeon: finalizeHealerBucket(healerBuckets.dungeon),
  };
  await writeJSON(join(SUMMARIES_DIR, "healer_mana.json"), healerMana);

  // 5c. Per-encounter healer stats
  const encounterHealerStats = {};
  for (const [id, specs] of Object.entries(encHealerBuckets)) {
    if (!encounterSummary[id]) continue;
    encounterHealerStats[id] = {
      encounterID: parseInt(id),
      name: encounterSummary[id].name,
      healers: finalizeHealerBucket(specs),
    };
  }
  await writeJSON(join(SUMMARIES_DIR, "encounter_healer_stats.json"), encounterHealerStats);

  const totalSamples = Object.values(specScaling.all).reduce(
    (s, v) => s + (v.samples ?? 0), 0
  );

  // 6. Meta — only update generatedAt when data actually changed
  let prevMeta = {};
  try { prevMeta = await readJSON(join(SUMMARIES_DIR, "meta.json")); } catch {}
  const dataChanged =
    totalReports !== prevMeta.totalReports ||
    totalFights !== prevMeta.totalFights ||
    totalSamples !== prevMeta.totalSamples;

  const meta = {
    generatedAt: dataChanged ? new Date().toISOString() : (prevMeta.generatedAt || new Date().toISOString()),
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
  console.log(`  Specs (all): ${Object.keys(specScaling.all).length}`);
  console.log(`  Healer specs: ${healerMana.all.length}`);
  console.log(`  Samples: ${totalSamples}`);
  console.log(`  Output: ${SUMMARIES_DIR}`);
}

main().catch((err) => {
  console.error(`build-summary failed: ${err.message}`);
  process.exit(1);
});
