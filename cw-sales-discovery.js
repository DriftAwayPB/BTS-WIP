/**
 * cw-sales-discovery.js
 *
 * DISCOVERY SCRIPT for the Sales tab (hardware, licensing renewals,
 * one-off product sales). Reuses the exact invoice/product-fetching
 * code already proven out for MRR — the only thing that's new here is
 * the invoice type filter: "Standard" instead of "Agreement".
 *
 * Also does one bonus check for free: tallies invoice `type` values
 * across a wider window, to confirm whether "Project" exists as its
 * own type — useful groundwork for the future Projects tab.
 *
 * Writes data/sales/_debug-invoices.json — not used by the dashboard,
 * just for us to review real line-item vocabulary together before
 * designing Sales categorization (Hardware vs Licensing/Renewal vs
 * Other, or whatever the real data suggests).
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 */

const fs = require("fs");
const path = require("path");

const { CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID, DISCOVERY_START_DATE } =
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

async function fetchInvoicesByType(type, startDate, endDate) {
  const conditions = encodeURIComponent(`type="${type}" and date>=[${startDate}] and date<=[${endDate}]`);
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

async function fetchAllInvoicesUnfiltered(startDate, endDate) {
  const conditions = encodeURIComponent(`date>=[${startDate}] and date<=[${endDate}]`);
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

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

async function main() {
  assertEnv();

  const endDate = new Date().toISOString();
  const startDate = DISCOVERY_START_DATE || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Bonus check: invoice type breakdown across a full year, so we know
  // whether "Project" is a real distinct type for the future Projects tab.
  const yearStart = "2025-01-01T00:00:00Z";
  console.log(`Checking invoice type distribution from ${yearStart} to ${endDate}...`);
  const allInvoicesThisYear = await fetchAllInvoicesUnfiltered(yearStart, endDate);
  const byType = {};
  for (const inv of allInvoicesThisYear) {
    const t = inv.type || "Unknown";
    byType[t] = (byType[t] || 0) + 1;
  }
  console.log("Invoice types found:", JSON.stringify(byType, null, 2));

  console.log(`Pulling Standard-type invoices from ${startDate} to ${endDate}...`);
  const invoices = await fetchInvoicesByType("Standard", startDate, endDate);
  console.log(`Fetched ${invoices.length} Standard invoices`);

  const byMonth = {};
  for (const inv of invoices) {
    const mk = monthKey(inv.date);
    byMonth[mk] = (byMonth[mk] || 0) + 1;
  }
  console.log("By month:", JSON.stringify(byMonth, null, 2));

  const slim = invoices.map((inv) => ({
    id: inv.id,
    date: inv.date,
    company: inv.company?.name || null,
    reference: inv.reference || null,
    productTotal: inv.productTotal ?? null,
    serviceTotal: inv.serviceTotal ?? null,
    total: inv.total ?? null,
  }));

  // Full product line-item detail for a spread of sample invoices —
  // this is what actually reveals hardware/licensing/renewal vocabulary.
  const sampleInvoices = invoices.slice(0, 20);
  const productSamples = [];
  const descriptionCounts = {};
  for (const inv of sampleInvoices) {
    let products = [];
    try {
      products = await fetchInvoiceProducts(inv.id);
    } catch (e) {
      console.warn(`  ⚠ failed to fetch products for invoice ${inv.id}: ${e.message}`);
      continue;
    }
    for (const p of products) {
      const desc = p.description || p.catalogItem?.identifier || "(no description)";
      descriptionCounts[desc] = (descriptionCounts[desc] || 0) + 1;
    }
    productSamples.push({ invoiceId: inv.id, company: inv.company?.name, reference: inv.reference, products });
  }

  const dataDir = path.join(__dirname, "data", "sales");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "_debug-invoices.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        invoiceTypesThisYear: byType,
        standardInvoiceCount: invoices.length,
        byMonth,
        descriptionCounts,
        slim,
        productSamples,
      },
      null,
      2
    )
  );
  console.log("Wrote data/sales/_debug-invoices.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
