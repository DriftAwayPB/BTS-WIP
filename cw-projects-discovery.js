/**
 * cw-projects-discovery.js
 *
 * DISCOVERY SCRIPT for a future Projects tab. We already know from the
 * Sales discovery pass that invoices don't have a "Project" type — just
 * Agreement, Standard, DownPayment, Progress (1 seen this year), and
 * CreditMemo. So project revenue isn't cleanly separated by invoice
 * type; it's likely tracked some other way. This checks three angles:
 *
 *   1. Time entries: does `chargeToType` distinguish "ProjectTicket"
 *      from "ServiceTicket"? If so, project work might be identifiable
 *      at the time-entry level regardless of which invoice it lands on.
 *   2. ConnectWise's own Project module (/project/projects) — actual
 *      project records, which may carry their own budget/billing
 *      summary directly, independent of invoices entirely.
 *   3. The one "Progress"-type invoice found this year — Progress
 *      billing is a classic project-billing method, worth seeing if it
 *      references a project directly.
 *
 * Writes data/projects/_debug-discovery.json — not used by the
 * dashboard, just for review before designing the real pull.
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

async function main() {
  assertEnv();
  const result = { generatedAt: new Date().toISOString() };

  // 1. Time entries — chargeToType distribution over the last 90 days
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  console.log("Checking time entry chargeToType distribution (last 90 days)...");
  const conditions = encodeURIComponent(`timeStart>=[${since}] and timeStart<=[${now}]`);
  const entries = await fetchPaginated("/time/entries", `&conditions=${conditions}`);
  const chargeToTypeCounts = {};
  for (const e of entries) {
    const t = e.chargeToType || "Unknown";
    chargeToTypeCounts[t] = (chargeToTypeCounts[t] || 0) + 1;
  }
  console.log("chargeToType counts:", JSON.stringify(chargeToTypeCounts, null, 2));
  result.chargeToTypeCounts = chargeToTypeCounts;
  result.sampleProjectTimeEntries = entries.filter((e) => e.chargeToType === "ProjectTicket").slice(0, 10);

  // 2. ConnectWise's own Project module
  console.log("Pulling /project/projects...");
  let projects = [];
  try {
    projects = await fetchPaginated("/project/projects");
    console.log(`Fetched ${projects.length} projects`);
  } catch (e) {
    console.warn(`  ⚠ failed to fetch /project/projects: ${e.message}`);
  }
  result.projectCount = projects.length;
  result.projectSamples = projects.slice(0, 10);

  // 3. The Progress-type invoice(s) found earlier this year
  console.log("Checking Progress-type invoices this year...");
  let progressInvoices = [];
  try {
    const progConditions = encodeURIComponent(`type="Progress" and date>=[2025-01-01T00:00:00Z]`);
    progressInvoices = await fetchPaginated("/finance/invoices", `&conditions=${progConditions}`);
    console.log(`Fetched ${progressInvoices.length} Progress invoices`);
  } catch (e) {
    console.warn(`  ⚠ failed to fetch Progress invoices: ${e.message}`);
  }
  result.progressInvoices = progressInvoices;

  // 4. ALL invoices tied to a project (any type), to see the real
  // deposit/completion billing pattern for Fixed Fee projects, and to
  // check whether any of these are currently typed "Standard" — which
  // would mean they're being miscounted as Sales hardware revenue.
  console.log("Checking all invoices with applyToType=Project since 2025-01-01...");
  let projectInvoices = [];
  try {
    const projConditions = encodeURIComponent(`applyToType="Project" and date>=[2025-01-01T00:00:00Z]`);
    projectInvoices = await fetchPaginated("/finance/invoices", `&conditions=${projConditions}`);
    console.log(`Fetched ${projectInvoices.length} project-linked invoices`);
  } catch (e) {
    console.warn(`  ⚠ failed to fetch project-linked invoices: ${e.message}`);
  }
  const projectInvoicesByType = {};
  for (const inv of projectInvoices) {
    const t = inv.type || "Unknown";
    projectInvoicesByType[t] = (projectInvoicesByType[t] || 0) + 1;
  }
  console.log("Project-linked invoices by type:", JSON.stringify(projectInvoicesByType, null, 2));
  result.projectInvoicesByType = projectInvoicesByType;
  result.projectInvoices = projectInvoices.map((inv) => ({
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    type: inv.type,
    date: inv.date,
    company: inv.company?.name || null,
    project: inv.project ? { id: inv.project.id, name: inv.project.name, billingMethod: inv.project._info?.billingMethod } : null,
    serviceTotal: inv.serviceTotal,
    productTotal: inv.productTotal,
    total: inv.total,
  }));

  const dataDir = path.join(__dirname, "data", "projects");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "_debug-discovery.json"), JSON.stringify(result, null, 2));
  console.log("Wrote data/projects/_debug-discovery.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
