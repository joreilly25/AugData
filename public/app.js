// AugData Frontend — vanilla JS dashboard

// ---------------------------------------------------------------------------
// Class colors & display helpers
// ---------------------------------------------------------------------------

const CLASS_COLORS = {
  DeathKnight: "#C41E3A",
  DemonHunter: "#A330C9",
  Druid: "#FF7C0A",
  Evoker: "#33937F",
  Hunter: "#AAD372",
  Mage: "#3FC7EB",
  Monk: "#00FF98",
  Paladin: "#F48CBA",
  Priest: "#FFFFFF",
  Rogue: "#FFF468",
  Shaman: "#0070DD",
  Warlock: "#8788EE",
  Warrior: "#C79C6E",
};

function classFromSpec(specIcon) {
  return specIcon.split("-")[0];
}

function specDisplayName(specIcon) {
  const [cls, spec] = specIcon.split("-");
  if (!spec) return cls;
  // "DemonHunter" -> "Demon Hunter", "DeathKnight" -> "Death Knight"
  const friendlyClass = cls.replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${spec} ${friendlyClass}`;
}

function specCell(specIcon) {
  const cls = classFromSpec(specIcon);
  return `<span class="spec-name class-${cls}">${specDisplayName(specIcon)}</span>`;
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return Math.floor(n).toLocaleString();
}

function fmtPct(n) {
  return n.toFixed(1) + "%";
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function numCell(value) {
  return `<td data-type="num">${value}</td>`;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

let data = { meta: {}, scaling: {}, encounters: {}, specMatrix: {} };

async function fetchData() {
  const [meta, scaling, encounters] = await Promise.all([
    fetch("/api/meta").then((r) => r.json()),
    fetch("/api/scaling").then((r) => r.json()),
    fetch("/api/encounters").then((r) => r.json()),
  ]);
  data = { meta, scaling, encounters, specMatrix: {} };
}

async function fetchSpecMatrix(encId) {
  if (data.specMatrix[encId]) return data.specMatrix[encId];
  const resp = await fetch(`/api/encounters/${encId}/specs`);
  if (!resp.ok) return null;
  const result = await resp.json();
  data.specMatrix[encId] = result;
  return result;
}

// ---------------------------------------------------------------------------
// Render: Meta header
// ---------------------------------------------------------------------------

function renderMeta() {
  const m = data.meta;
  const el = document.getElementById("meta");
  const parts = [];
  if (m.totalReports) parts.push(`<span>${m.totalReports} reports</span>`);
  if (m.totalFights) parts.push(`<span>${m.totalFights} fights</span>`);
  if (m.totalSamples) parts.push(`<span>${m.totalSamples.toLocaleString()} samples</span>`);
  if (m.generatedAt) {
    const ago = timeAgo(new Date(m.generatedAt));
    parts.push(`<span>Updated ${ago}</span>`);
  }
  el.innerHTML = parts.join("");
}

function timeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Render: Spec Scaling table
// ---------------------------------------------------------------------------

let scalingSort = { key: "avgElasticity", dir: "desc" };
let scalingFilter = "all";

function renderScalingTable() {
  const scalingData = data.scaling[scalingFilter] || data.scaling.all || data.scaling;
  const specs = Object.values(scalingData).filter(
    (s) => !s.spec.includes("Augmentation")
  );

  specs.sort((a, b) => {
    const av = a[scalingSort.key];
    const bv = b[scalingSort.key];
    if (typeof av === "string") {
      return scalingSort.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return scalingSort.dir === "asc" ? av - bv : bv - av;
  });

  const tbody = document.querySelector("#scaling-table tbody");
  tbody.innerHTML = specs
    .map(
      (s) => `<tr>
      <td>${specCell(s.spec)}</td>
      ${numCell(s.avgElasticity.toFixed(4))}
      ${numCell(fmtPct(s.avgAttributionPct))}
      ${numCell(s.samples.toLocaleString())}
    </tr>`
    )
    .join("");

  // Update sort indicators
  document.querySelectorAll("#scaling-table th").forEach((th) => {
    th.classList.remove("sorted", "asc", "desc");
    if (th.dataset.sort === scalingSort.key) {
      th.classList.add("sorted", scalingSort.dir);
    }
  });
}

function initScalingSorting() {
  document.querySelectorAll("#scaling-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (scalingSort.key === key) {
        scalingSort.dir = scalingSort.dir === "desc" ? "asc" : "desc";
      } else {
        scalingSort.key = key;
        scalingSort.dir = th.dataset.type === "num" ? "desc" : "asc";
      }
      renderScalingTable();
    });
  });
}

function initScalingFilter() {
  const btns = document.querySelectorAll("#scaling-filter .filter-btn");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      btns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      scalingFilter = btn.dataset.filter;
      renderScalingTable();
    });
  });
}

// ---------------------------------------------------------------------------
// Render: Prescience Targets
// ---------------------------------------------------------------------------

const TYPE_ORDER = ["raid", "dungeon", "delve"];
const TYPE_LABELS = { raid: "Raids", dungeon: "Dungeons", delve: "Delves" };

/** Groups encounters into type → zoneName → encounters[] */
function groupByTypeAndZone(encounters) {
  const result = {};
  for (const e of encounters) {
    const t = e.type || "dungeon";
    const z = e.zoneName || "Unknown";
    if (!result[t]) result[t] = {};
    if (!result[t][z]) result[t][z] = [];
    result[t][z].push(e);
  }
  return result;
}

function renderBossSelect() {
  const select = document.getElementById("boss-select");
  const encounters = Object.values(data.encounters).sort(
    (a, b) => b.totalFights - a.totalFights
  );

  const groups = groupByTypeAndZone(encounters);
  let html = "";
  for (const type of TYPE_ORDER) {
    const zones = groups[type];
    if (!zones) continue;
    for (const [zoneName, encs] of Object.entries(zones)) {
      html += `<optgroup label="${zoneName}">`;
      html += encs
        .map((e) => `<option value="${e.encounterID}">${e.name}</option>`)
        .join("");
      html += `</optgroup>`;
    }
  }
  select.innerHTML = html;

  select.addEventListener("change", () => loadPrescienceTable(select.value));

  if (encounters.length) loadPrescienceTable(encounters[0].encounterID);
}

async function loadPrescienceTable(encId) {
  const tbody = document.querySelector("#prescience-table tbody");
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';

  const matrix = await fetchSpecMatrix(encId);
  if (!matrix || !matrix.specs?.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="loading">No data for this encounter</td></tr>';
    return;
  }

  tbody.innerHTML = matrix.specs
    .map(
      (s) => `<tr>
      <td>${specCell(s.spec)}</td>
      ${numCell(fmt(s.avgAttributed))}
      ${numCell(fmt(s.avgAttributedDPS))}
      ${numCell(fmt(s.avgTotalDmg))}
      ${numCell(fmtPct(s.avgAttributedPct))}
      ${numCell(s.count.toLocaleString())}
    </tr>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Render: Aug Contribution cards
// ---------------------------------------------------------------------------

function renderContributionCards() {
  const container = document.getElementById("contribution-cards");
  const encounters = Object.values(data.encounters).sort(
    (a, b) => b.avgAugDPS - a.avgAugDPS
  );

  const groups = groupByTypeAndZone(encounters);
  let html = "";
  for (const type of TYPE_ORDER) {
    const zones = groups[type];
    if (!zones) continue;
    html += `<h3 class="section-heading">${TYPE_LABELS[type]}</h3>`;
    for (const [zoneName, encs] of Object.entries(zones)) {
      html += `<h4 class="zone-heading">${zoneName}</h4>`;
      html += `<div class="cards">`;
      html += encs
        .map(
          (e) => `<div class="card">
          <h3>${e.name}</h3>
          <div class="card-stat highlight">
            <span class="label">Avg Aug DPS</span>
            <span class="value">${fmt(e.avgAugDPS)}</span>
          </div>
          <div class="card-stat">
            <span class="label">Avg Attributed</span>
            <span class="value">${fmt(e.avgAugAttributed)}</span>
          </div>
          <div class="card-stat">
            <span class="label">Aug % of Raid</span>
            <span class="value">${fmtPct(e.avgAugAttributedPct)}</span>
          </div>
          <div class="card-stat">
            <span class="label">Avg Duration</span>
            <span class="value">${fmtDuration(e.avgDurationSec)}</span>
          </div>
          <div class="card-stat">
            <span class="label">Fights</span>
            <span class="value">${e.totalFights}</span>
          </div>
        </div>`
        )
        .join("");
      html += `</div>`;
    }
  }
  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Render: Per-Boss Breakdown table
// ---------------------------------------------------------------------------

function renderBossesTable() {
  const encounters = Object.values(data.encounters).sort(
    (a, b) => b.totalFights - a.totalFights
  );

  const groups = groupByTypeAndZone(encounters);
  const tbody = document.querySelector("#bosses-table tbody");
  let html = "";
  for (const type of TYPE_ORDER) {
    const zones = groups[type];
    if (!zones) continue;
    html += `<tr class="group-header"><td colspan="7">${TYPE_LABELS[type]}</td></tr>`;
    for (const [zoneName, encs] of Object.entries(zones)) {
      html += `<tr class="zone-header"><td colspan="7">${zoneName}</td></tr>`;
      html += encs
        .map(
          (e) => `<tr>
          <td>${e.name}</td>
          ${numCell(e.totalFights)}
          ${numCell(e.kills)}
          ${numCell(fmtDuration(e.avgDurationSec))}
          ${numCell(fmt(e.avgRaidDPS))}
          ${numCell(fmt(e.avgAugDPS))}
          ${numCell(fmtPct(e.avgAugAttributedPct))}
        </tr>`
        )
        .join("");
    }
  }
  tbody.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const views = document.querySelectorAll(".view");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      views.forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`view-${tab.dataset.view}`).classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  initTabs();

  try {
    await fetchData();
    renderMeta();
    renderScalingTable();
    initScalingSorting();
    initScalingFilter();
    renderBossSelect();
    renderContributionCards();
    renderBossesTable();
  } catch (err) {
    document.querySelector("main").innerHTML =
      `<div class="loading">Failed to load data: ${err.message}</div>`;
  }
}

init();
