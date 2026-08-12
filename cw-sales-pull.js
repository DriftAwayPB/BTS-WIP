/**
 * cw-sales-pull.js
 *
 * Pulls the CURRENT month's Sales revenue — hardware, cloud consumption,
 * and other one-off product sales — from ConnectWise Standard-type
 * invoices. Confirmed from real data before writing this:
 *
 *   - "Standard" invoices are actually two different things mixed
 *     together: real product/hardware sales (has a `reference` like
 *     "Order #697", line items carry a `salesOrder`), AND the monthly
 *     WIP billing batch (no reference, pure `serviceTotal`, no product
 *     line items). The WIP tab already tracks that second category from
 *     Time Entries directly — counting serviceTotal here would double
 *     it into a second tab.
 *   - Fix: Sales ONLY sums Product line items (extPrice). It never
 *     looks at invoice.serviceTotal at all. This works even on the rare
 *     invoice that mixes both (e.g. a client's Azure Consumption riding
 *     on the same invoice as their monthly WIP overage) — the product
 *     rows get counted, the serviceTotal rows just get ignored.
 *   - Categorization: real data so far shows mostly hardware (access
 *     points, switches, cable, PCs) plus a distinct "Azure Consumption"
 *     line. Starting with two categories — Hardware/Equipment (default)
 *     and Cloud/Consumption (keyword match) — expected to refine once
 *     more real data comes in, same as MRR's category rules evolved.
 *
 * Writes:
 *   data/sales/current.json           — latest snapshot (current month)
 *   data/sales/history/YYYY-MM.json   — same snapshot, filed by month
 *   data/sales/manifest.json          — list of available history months
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 *
 * Optional:
 *   SALES_CLOUD_KEYWORDS   comma-separated, case-insensitive substrings
 *                          that mark a line item as "Cloud/Consumption"
 *                          rather than "Hardware/Equipment".
 *                          Default: "azure consumption,consumption,cloud"
 */

const fs = require("fs");
const path = require("path");

const { CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID, SALES_CLOUD_KEYWORDS } =
  process.env;

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

async function fetchStandardInvoices(startDate, endDate) {
  const conditions = encodeURIComponent(`type="Standard" and date>=[${startDate}] and date<=[${endDate}]`);
  let page = 1;
  const pageSize = 1000;
  const all = [];
  while (true) {
    const url = `${CW_BASE_URL}/finance/invoices?conditions=${conditions}&page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader(), clientId: CW_CLIENT_ID, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ConnectWise API error ${res.status}: ${body}`);
    }
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
  }
  return all;
}

async function fetchInvoiceProducts(invoiceId) {
  const url = `${CW_BASE_URL}/procurement/products?conditions=invoice/id=${invoiceId}&pageSize=1000`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), clientId: CW_CLIENT_ID, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ConnectWise API error ${res.status} fetching products for invoice ${invoiceId}: ${body}`);
  }
  return res.json();
}

const DEFAULT_CLOUD_KEYWORDS = ["azure consumption", "consumption", "cloud"];
function parseCloudKeywords() {
  if (!SALES_CLOUD_KEYWORDS) return DEFAULT_CLOUD_KEYWORDS;
  return SALES_CLOUD_KEYWORDS.split(",").map((s) => s.trim()).filter(Boolean);
}

function categorize(text, keywords) {
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase())) ? "Cloud/Consumption" : "Hardware/Equipment";
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isoDate(d) {
  return d.toISOString().split("T")[0];
}

/**
 * Builds a Sales snapshot from a set of Standard-type invoices —
 * PRODUCT LINE ITEMS ONLY, never serviceTotal (see file header).
 */
async function buildSalesFromInvoices(invoices, keywords) {
  const byCategory = { "Hardware/Equipment": 0, "Cloud/Consumption": 0 };
  const byClientMap = new Map();
  const invoiceRecords = [];
  let totalSales = 0;

  for (const inv of invoices) {
    const company = inv.company?.name || "Unknown";
    let products = [];
    try {
      products = await fetchInvoiceProducts(inv.id);
    } catch (e) {
      console.warn(`  ⚠ failed to fetch products for invoice ${inv.id}: ${e.message}`);
    }

    if (!products.length) continue; // pure WIP-billing invoice, nothing to count here

    const lineRecords = [];
    for (const p of products) {
      const amt = Number(p.extPrice) || 0;
      const category = categorize(`${p.description} ${p.catalogItem?.identifier || ""}`, keywords);
      lineRecords.push({
        description: p.description,
        productIdentifier: p.catalogItem?.identifier || null,
        quantity: p.quantity ?? null,
        unitPrice: p.price ?? null,
        extPrice: p.extPrice ?? null,
        category,
        amount: Number(amt.toFixed(2)),
      });
      byCategory[category] += amt;
      totalSales += amt;
      if (!byClientMap.has(company)) byClientMap.set(company, { hardware: 0, cloud: 0 });
      const c = byClientMap.get(company);
      if (category === "Cloud/Consumption") c.cloud += amt;
      else c.hardware += amt;
    }

    invoiceRecords.push({
      id: inv.id,
      date: inv.date,
      company,
      reference: inv.reference || null,
      lineItems: lineRecords,
      invoiceTotal: Number(lineRecords.reduce((s, r) => s + r.amount, 0).toFixed(2)),
    });
  }

  const byClient = Array.from(byClientMap.entries())
    .map(([client, v]) => ({
      client,
      hardwareTotal: Number(v.hardware.toFixed(2)),
      cloudTotal: Number(v.cloud.toFixed(2)),
      total: Number((v.hardware + v.cloud).toFixed(2)),
    }))
    .sort((a, b) => b.total - a.total);

  invoiceRecords.sort((a, b) => b.invoiceTotal - a.invoiceTotal);

  return {
    totalSales: Number(totalSales.toFixed(2)),
    byCategory: {
      "Hardware/Equipment": Number(byCategory["Hardware/Equipment"].toFixed(2)),
      "Cloud/Consumption": Number(byCategory["Cloud/Consumption"].toFixed(2)),
    },
    byClient,
    invoices: invoiceRecords,
  };
}

async function main() {
  assertEnv();
  const keywords = parseCloudKeywords();
  const today = new Date();
  const key = monthKey(today);
  const monthStart = `${key}-01T00:00:00Z`;

  console.log(`Pulling current-month (${key}) Standard invoices, ${monthStart} → ${today.toISOString()}...`);
  const invoices = await fetchStandardInvoices(monthStart, today.toISOString());
  console.log(`Fetched ${invoices.length} Standard invoices so far this month`);

  const sales = await buildSalesFromInvoices(invoices, keywords);
  console.log(`Sales so far this month: $${sales.totalSales} (${sales.invoices.length} product-bearing invoices, ${invoices.length - sales.invoices.length} pure-WIP invoices skipped)`);

  const dataDir = path.join(__dirname, "data", "sales");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    isCurrentMonth: true,
    currentDate: isoDate(today),
    totalSales: sales.totalSales,
    byCategory: sales.byCategory,
    byClient: sales.byClient,
    invoices: sales.invoices,
    flagged: [],
  };

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
