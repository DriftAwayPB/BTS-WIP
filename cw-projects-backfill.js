/**
 * cw-projects-backfill.js
 *
 * Reconstructs historical project revenue (Jan 2025 -> last month) into
 * data/projects/history/YYYY-MM.json, using the same rule confirmed for
 * the live pull: sum every invoice where applyToType === "Project",
 * using each invoice's `total` field (correctly nets a completion
 * invoice against its downpayment credit).
 *
 * Unlike the live pull, this does NOT compute invoicedToDate/remaining
 * per project per historical month (that's a "current status" concept,
 * not a monthly-history one, and would mean re-querying each project's
 * full invoice history once per month — expensive and not meaningful
 * for a closed past month anyway). Historical months just show what
 * actually landed that month.
 *
 * Each unique project record is fetched once and cached, since a
 * project's name/billingMethod doesn't change month to month.
 *
 * Skips only the CURRENT month (owned by the live pull).
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 * Optional: BACKFILL_START (default "2025-01")
 */

const fs = require("fs");
const path = require("path");

const { CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID, BACKFILL_START } = process.env;

function assertEnv() {
  const required = ["CW_BASE_URL", "CW_COMPANY_ID", "CW_PUBLIC_KEY", "CW_PRIVATE_KEY", "CW_CLIENT_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function authHeader() {
  const raw = `${CW_COMPANY_ID}+${CW_PUBLIC_KEY}:${CW_PRIVATE_KEY}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function cwGet(pathAndQuery) {
  const url = `${CW_BASE_URL}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), clientId: CW_CLIENT_ID, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ConnectWise API error ${res.status} for ${pathAndQuery}: ${body}`);
  }
  return res.json();
}

async function fetchPaginated(basePath, extraParams = "") {
  let page = 1;
  const pageSize = 1000;
  const all = [];
  while (true) {
    const batch = await cwGet(`${basePath}?page=${page}&pageSize=${pageSize}${extraParams}`);
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
  }
  return all;
}

async function fetchAllProjectInvoices(startDate, endDate) {
  const conditions = encodeURIComponent(`applyToType="Project" and date>=[${startDate}] and date<=[${endDate}]`);
  return fetchPaginated("/finance/invoices", `&conditions=${conditions}`);
}

const projectCache = new Map();
async function fetchProjectCached(projectId) {
  if (projectCache.has(projectId)) return projectCache.get(projectId);
  let project = null;
  try {
    project = await cwGet(`/project/projects/${projectId}`);
  } catch (e) {
    console.warn(`  ⚠ failed to fetch project ${projectId}: ${e.message}`);
  }
  projectCache.set(projectId, project);
  return project;
}

function categorize(billingMethod) {
  if (billingMethod === "FixedFee") return "Fixed Fee";
  if (billingMethod === "ActualRates") return "Time & Materials";
  return "Other";
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  assertEnv();
  const startDate = (BACKFILL_START || "2025-01") + "-01T00:00:00Z";
  const endDate = new Date().toISOString();
  const skipMonth = currentMonthKey();

  console.log(`Pulling all project invoices from ${startDate} to ${endDate}...`);
  const invoices = await fetchAllProjectInvoices(startDate, endDate);
  console.log(`Fetched ${invoices.length} project-linked invoices`);

  const byMonthInvoices = {};
  for (const inv of invoices) {
    const mk = monthKey(inv.date);
    if (mk === skipMonth) continue;
    if (!byMonthInvoices[mk]) byMonthInvoices[mk] = [];
    byMonthInvoices[mk].push(inv);
  }

  const months = Object.keys(byMonthInvoices).sort();
  console.log(`Backfilling ${months.length} closed months: ${months.join(", ")}`);

  const dataDir = path.join(__dirname, "data", "projects");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  for (const mk of months) {
    const monthInvoices = byMonthInvoices[mk];

    const invoicesByProject = new Map();
    for (const inv of monthInvoices) {
      const projId = inv.project?.id ?? inv.applyToId;
      if (!projId) continue;
      if (!invoicesByProject.has(projId)) invoicesByProject.set(projId, []);
      invoicesByProject.get(projId).push(inv);
    }

    const byCategory = { "Fixed Fee": 0, "Time & Materials": 0, "Other": 0 };
    const byClientMap = new Map();
    const projectRecords = [];
    let totalProjects = 0;

    for (const [projId, projInvoices] of invoicesByProject.entries()) {
      const project = await fetchProjectCached(projId);
      if (!project) continue;

      const company = project.company?.name || projInvoices[0]?.company?.name || "Unknown";
      const category = categorize(project.billingMethod);
      const monthTotal = projInvoices.reduce((s, inv) => s + (Number(inv.total) || 0), 0);

      totalProjects += monthTotal;
      byCategory[category] = (byCategory[category] || 0) + monthTotal;
      if (!byClientMap.has(company)) byClientMap.set(company, { fixedFee: 0, tm: 0, other: 0 });
      const c = byClientMap.get(company);
      if (category === "Fixed Fee") c.fixedFee += monthTotal;
      else if (category === "Time & Materials") c.tm += monthTotal;
      else c.other += monthTotal;

      projectRecords.push({
        id: projId,
        name: project.name,
        company,
        billingMethod: project.billingMethod,
        category,
        status: project.status?.name || null,
        closedFlag: !!project.closedFlag,
        contractValue: null, // not computed for historical months — see file header
        invoicedToDate: null,
        remaining: null,
        percentInvoiced: null,
        thisMonthTotal: Number(monthTotal.toFixed(2)),
        thisMonthInvoices: projInvoices.map((inv) => ({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          type: inv.type,
          date: inv.date,
          total: inv.total,
        })),
      });
    }

    const byClient = Array.from(byClientMap.entries())
      .map(([client, v]) => ({
        client,
        fixedFeeTotal: Number(v.fixedFee.toFixed(2)),
        tmTotal: Number(v.tm.toFixed(2)),
        total: Number((v.fixedFee + v.tm + v.other).toFixed(2)),
      }))
      .sort((a, b) => b.total - a.total);

    projectRecords.sort((a, b) => b.thisMonthTotal - a.thisMonthTotal);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      isCurrentMonth: false,
      totalProjects: Number(totalProjects.toFixed(2)),
      byCategory: {
        "Fixed Fee": Number(byCategory["Fixed Fee"].toFixed(2)),
        "Time & Materials": Number(byCategory["Time & Materials"].toFixed(2)),
        "Other": Number(byCategory["Other"].toFixed(2)),
      },
      byClient,
      projects: projectRecords,
      activeProjects: [], // in-progress snapshot is a "right now" concept, only meaningful on the live pull
      flagged: [],
      historical: true,
    };

    fs.writeFileSync(path.join(historyDir, `${mk}.json`), JSON.stringify(snapshot, null, 2));
    console.log(`  wrote data/projects/history/${mk}.json — total $${snapshot.totalProjects}`);
  }

  const existing = fs.readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();

  let latest = existing[existing.length - 1];
  const manifestPath = path.join(dataDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (prior.latest) latest = prior.latest;
    } catch (e) {
      // fall through with reconstructed value
    }
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), months: existing, latest }, null, 2)
  );
  console.log(`Wrote data/projects/manifest.json (${existing.length} months total)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
