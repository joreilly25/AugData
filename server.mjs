/**
 * AugData Web Dashboard — Express server.
 *
 * Serves the frontend, exposes summary data via JSON API,
 * and runs the pipeline + summary builder on a background interval.
 */

import express from "express";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const SUMMARIES_DIR = join(DATA_DIR, "summaries");
const PORT = process.env.PORT || 3000;

// Pipeline interval (default 6 hours)
const PIPELINE_INTERVAL_MS =
  parseInt(process.env.PIPELINE_INTERVAL_HOURS || "6", 10) * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

let summaries = { scaling: {}, encounters: {}, specMatrix: {}, meta: {} };

async function loadSummaries() {
  try {
    const [scaling, encounters, specMatrix, meta] = await Promise.all([
      readJSON(join(SUMMARIES_DIR, "spec_scaling.json")),
      readJSON(join(SUMMARIES_DIR, "encounter_summary.json")),
      readJSON(join(SUMMARIES_DIR, "encounter_spec_matrix.json")),
      readJSON(join(SUMMARIES_DIR, "meta.json")),
    ]);
    summaries = { scaling, encounters, specMatrix, meta };
    console.log(
      `[${ts()}] Summaries loaded: ${meta.totalReports} reports, ${meta.totalFights} fights`
    );
  } catch (err) {
    console.warn(`[${ts()}] Could not load summaries: ${err.message}`);
  }
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ---------------------------------------------------------------------------
// Background pipeline runner
// ---------------------------------------------------------------------------

let pipelineRunning = false;

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [join(__dirname, scriptName)], {
      stdio: "inherit",
      env: { ...process.env, DATA_DIR },
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function runPipelineAndRebuild() {
  if (pipelineRunning) {
    console.log(`[${ts()}] Pipeline already running, skipping`);
    return;
  }
  pipelineRunning = true;
  console.log(`[${ts()}] Starting pipeline...`);
  try {
    await runScript("pipeline.mjs");
    console.log(`[${ts()}] Pipeline done. Building summaries...`);
    await runScript("build-summary.mjs");
    await loadSummaries();
    console.log(`[${ts()}] Summaries refreshed`);
  } catch (err) {
    console.error(`[${ts()}] Pipeline/summary error: ${err.message}`);
  } finally {
    pipelineRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(express.static(join(__dirname, "public")));

// Cache-Control for API responses (1 hour)
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "public, max-age=3600");
  next();
});

app.get("/api/meta", (req, res) => res.json(summaries.meta));
app.get("/api/scaling", (req, res) => res.json(summaries.scaling));
app.get("/api/encounters", (req, res) => res.json(summaries.encounters));

app.get("/api/encounters/:id/specs", (req, res) => {
  const data = summaries.specMatrix[req.params.id];
  if (!data) return res.status(404).json({ error: "Encounter not found" });
  res.json(data);
});

// Status endpoint for health checks
app.get("/api/status", (req, res) =>
  res.json({ ok: true, pipelineRunning, lastUpdated: summaries.meta.generatedAt })
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await loadSummaries();

app.listen(PORT, () => {
  console.log(`[${ts()}] AugData dashboard running on port ${PORT}`);
});

// Run pipeline on startup (delayed 10s to let server start), then on interval
if (process.env.WCL_CLIENT_ID && process.env.WCL_CLIENT_SECRET) {
  setTimeout(() => runPipelineAndRebuild(), 10_000);
  setInterval(() => runPipelineAndRebuild(), PIPELINE_INTERVAL_MS);
  console.log(
    `[${ts()}] Pipeline scheduled every ${PIPELINE_INTERVAL_MS / 3600000}h`
  );
} else {
  console.log(`[${ts()}] No WCL credentials — pipeline disabled (serving existing data only)`);
}
