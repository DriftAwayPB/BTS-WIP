/**
 * cw-projects-pull.js
 *
 * Pulls the CURRENT month's project revenue, using the rule confirmed
 * during discovery: sum every invoice where applyToType === "Project"
 * (regardless of the invoice's own type — DownPayment, Standard, and
 * Progress were all seen in real data), using each invoice's `total`
 * field — NOT `serviceTotal`, since a completion invoice's serviceTotal
 * shows the full contract value while `total` correctly nets out the
 * downpayment already credited.
 *
 * Beyond just "revenue this month," this also tracks each touched
 * project's full lifecycle: contract value (for Fixed Fee), total
 * invoiced to date across ALL months, and what's remaining — since
 * these are the shop's real 50%-up-front/50%-at-completion projects,
 * and knowing "$3,125 of $6,250 collected" for an in-progress project
 * is exactly the kind of thing worth surfacing.
 *
 * Categorizes by the PROJECT's own billingMethod field:
 *   FixedFee    -> "Fixed Fee"
 *   ActualRates -> "Time & Materials"
 *   anything else -> "Other"
 *
 * Writes:
 *   data/projects/current.json           — latest snapshot (current month)
 *   data/projects/history/YYYY-MM.json   — same snapshot, filed by month
 *   data/projects/manifest.json          — list of available history months
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 */

const fs = require("fs");
const path = require("path");

const { CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID } = process.env;

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

async function fetchProjectInvoicesInRange(startDate, endDate) {
  const conditions = encodeURIComponent(`applyToType="Project" and date>=[${startDate}] and date<=[${endDate}]`);
  return fetchPaginated("/finance/invoices", `&conditions=${conditions}`);
}

async function fetchActiveProjects() {
  const conditions = encodeURIComponent(`closedFlag=false`);
  return fetchPaginated("/project/projects", `&conditions=${conditions}`);
}

async function fetchAllInvoicesForProject(projectId) {
  const conditions = encodeURIComponent(`applyToType="Project" and applyToId=${projectId}`);
  return fetchPaginated("/finance/invoices", `&conditions=${conditions}`);
}

async function fetchProjectRecord(projectId) {
  return cwGet(`/project/projects/${projectId}`);
}

function categorize(billingMethod) {
  if (billingMethod === "FixedFee") return "Fixed Fee";
  if (billingMethod === "ActualRates") return "Time & Materials";
  return "Other";
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function isoDate(d) {
  return d.toISOString().split("T")[0];
}

async function main() {
  assertEnv();

  const now = new Date();
  const key = monthKey(now.toISOString());
  const monthStart = `${key}-01T00:00:00Z`;

  console.log(`Pulling current-month (${key}) project invoices, ${monthStart} → ${now.toISOString()}...`);
  const invoices = await fetchProjectInvoicesInRange(monthStart, now.toISOString());
  console.log(`Fetched ${invoices.length} project-linked invoices this month`);

  // Group this month's invoices by project ID
  const invoicesByProject = new Map();
  for (const inv of invoices) {
    const projId = inv.project?.id ?? inv.applyToId;
    if (!projId) continue;
    if (!invoicesByProject.has(projId)) invoicesByProject.set(projId, []);
    invoicesByProject.get(projId).push(inv);
  }

  const byCategory = { "Fixed Fee": 0, "Time & Materials": 0, "Other": 0 };
  const byClientMap = new Map();
  const projectRecords = [];
  let totalProjects = 0;
  const flagged = [];

  for (const [projId, projInvoices] of invoicesByProject.entries()) {
    let project;
    try {
      project = await fetchProjectRecord(projId);
    } catch (e) {
      console.warn(`  ⚠ failed to fetch project ${projId}: ${e.message}`);
      flagged.push({ projectId: projId, issue: `Failed to fetch project record: ${e.message}` });
      continue;
    }

    const company = project.company?.name || projInvoices[0]?.company?.name || "Unknown";
    const category = categorize(project.billingMethod);
    const thisMonthTotal = projInvoices.reduce((s, inv) => s + (Number(inv.total) || 0), 0);

    totalProjects += thisMonthTotal;
    byCategory[category] = (byCategory[category] || 0) + thisMonthTotal;
    if (!byClientMap.has(company)) byClientMap.set(company, { fixedFee: 0, tm: 0, other: 0 });
    const c = byClientMap.get(company);
    if (category === "Fixed Fee") c.fixedFee += thisMonthTotal;
    else if (category === "Time & Materials") c.tm += thisMonthTotal;
    else c.other += thisMonthTotal;

    // To-date totals across ALL invoices for this project (not just this
    // month) — this is what makes "50% collected, 50% remaining" possible.
    let invoicedToDate = thisMonthTotal;
    try {
      const allProjectInvoices = await fetchAllInvoicesForProject(projId);
      invoicedToDate = allProjectInvoices.reduce((s, inv) => s + (Number(inv.total) || 0), 0);
    } catch (e) {
      console.warn(`  ⚠ failed to fetch full invoice history for project ${projId}: ${e.message}`);
    }

    const contractValue = category === "Fixed Fee" ? Number(project.billingAmount) || null : null;
    const remaining = contractValue !== null ? Number((contractValue - invoicedToDate).toFixed(2)) : null;
    const percentInvoiced = contractValue ? Number(((invoicedToDate / contractValue) * 100).toFixed(1)) : null;

    projectRecords.push({
      id: projId,
      name: project.name,
      company,
      billingMethod: project.billingMethod,
      category,
      status: project.status?.name || null,
      closedFlag: !!project.closedFlag,
      contractValue,
      invoicedToDate: Number(invoicedToDate.toFixed(2)),
      remaining,
      percentInvoiced,
      thisMonthTotal: Number(thisMonthTotal.toFixed(2)),
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

  byCategory["Fixed Fee"] = Number(byCategory["Fixed Fee"].toFixed(2));
  byCategory["Time & Materials"] = Number(byCategory["Time & Materials"].toFixed(2));
  byCategory["Other"] = Number(byCategory["Other"].toFixed(2));
  totalProjects = Number(totalProjects.toFixed(2));

  console.log(`Total project revenue this month: $${totalProjects} across ${projectRecords.length} projects`);

  // In-progress snapshot: every currently open project, regardless of
  // whether it had an invoice this specific month. This is what fixes
  // the "project between invoices is invisible" gap — a Fixed Fee
  // project sitting between its deposit and completion invoice would
  // otherwise vanish from every month's view until the next invoice
  // actually lands.
  console.log("Pulling all currently open (non-closed) projects for the in-progress snapshot...");
  let activeProjects = [];
  try {
    const openProjects = await fetchActiveProjects();
    console.log(`  found ${openProjects.length} open projects`);
    for (const project of openProjects) {
      let invoicedToDate = 0;
      try {
        const allInvoices = await fetchAllInvoicesForProject(project.id);
        invoicedToDate = allInvoices.reduce((s, inv) => s + (Number(inv.total) || 0), 0);
      } catch (e) {
        console.warn(`  ⚠ failed to fetch invoices for open project ${project.id}: ${e.message}`);
      }
      const category = categorize(project.billingMethod);
      const contractValue = category === "Fixed Fee" ? Number(project.billingAmount) || null : null;
      const remaining = contractValue !== null ? Number((contractValue - invoicedToDate).toFixed(2)) : null;
      const percentInvoiced = contractValue ? Number(((invoicedToDate / contractValue) * 100).toFixed(1)) : null;

      activeProjects.push({
        id: project.id,
        name: project.name,
        company: project.company?.name || null,
        billingMethod: project.billingMethod,
        category,
        status: project.status?.name || null,
        percentComplete: project.percentComplete ?? null,
        estimatedStart: project.estimatedStart || null,
        estimatedEnd: project.estimatedEnd || null,
        contractValue,
        invoicedToDate: Number(invoicedToDate.toFixed(2)),
        remaining,
        percentInvoiced,
      });
    }
  } catch (e) {
    console.warn(`  ⚠ failed to fetch open projects list: ${e.message}`);
  }
  activeProjects.sort((a, b) => (a.estimatedEnd || "9999").localeCompare(b.estimatedEnd || "9999"));
  console.log(`Built in-progress snapshot for ${activeProjects.length} open projects`);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    isCurrentMonth: true,
    currentDate: isoDate(now),
    totalProjects,
    byCategory,
    byClient,
    projects: projectRecords,
    activeProjects,
    flagged,
  };

  const dataDir = path.join(__dirname, "data", "projects");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, "current.json"), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(path.join(historyDir, `${key}.json`), JSON.stringify(snapshot, null, 2));

  const existing = fs.readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();

  fs.writeFileSync(
    path.join(dataDir, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), months: existing, latest: key }, null, 2)
  );

  console.log(`Wrote current.json, history/${key}.json, manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
