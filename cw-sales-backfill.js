/**
 * cw-sales-backfill.js
 *
 * Reconstructs historical Sales revenue (Jan 2025 -> the month before
 * the current one) from real Standard-type invoices. Same method as
 * cw-sales-pull.js: PRODUCT LINE ITEMS ONLY, never serviceTotal — see
 * that file's header for why (Standard invoices mix real product sales
 * with the monthly WIP billing batch, and WIP already owns that
 * revenue in its own tab).
 *
 * Does NOT touch the current (in-progress) month — that's owned by
 * cw-sales-pull.js.
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 * Optional: SALES_CLOUD_KEYWORDS (same as cw-sales-pull.js)
 */

const fs = require("fs");
const path = require("path");

const {
  CW_BASE_URL,
  CW_COMPANY_ID,
  CW_PUBLIC_KEY,
  CW_PRIVATE_KEY,
  CW_CLIENT_ID,
  SALES_CLOUD_KEYWORDS,
  BACKFILL_START_DATE,
} = process.env;

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

const DEFAULT_CLOUD_KEYWORDS = ["consumption"];
function parseCloudKeywords() {
  if (!SALES_CLOUD_KEYWORDS) return DEFAULT_CLOUD_KEYWORDS;
  return SALES_CLOUD_KEYWORDS.split(",").map((s) => s.trim()).filter(Boolean);
}

function categorize(text, keywords) {
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase())) ? "Cloud/Consumption" : "Hardware/Equipment";
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
  const keywords = parseCloudKeywords();
  const startDate = BACKFILL_START_DATE || "2025-01-01T00:00:00Z";
  const endDate = new Date().toISOString();
  const skipMonth = currentMonthKey();

  console.log(`Pulling Standard invoices from ${startDate} to ${endDate}...`);
  const invoices = await fetchStandardInvoices(startDate, endDate);
  console.log(`Fetched ${invoices.length} Standard invoices`);

  const byMonthInvoices = {};
  for (const inv of invoices) {
    const mk = monthKey(inv.date);
    if (mk === skipMonth) continue;
    if (!byMonthInvoices[mk]) byMonthInvoices[mk] = [];
    byMonthInvoices[mk].push(inv);
  }

  const months = Object.keys(byMonthInvoices).sort();
  console.log(`Backfilling ${months.length} closed months: ${months.join(", ")}`);

  const dataDir = path.join(__dirname, "data", "sales");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  for (const mk of months) {
    const monthInvoices = byMonthInvoices[mk];
    const byCategory = { "Hardware/Equipment": 0, "Cloud/Consumption": 0 };
    const byClientMap = new Map();
    const invoiceRecords = [];
    let totalSales = 0;

    for (const inv of monthInvoices) {
      const company = inv.company?.name || "Unknown";
      let products = [];
      try {
        products = await fetchInvoiceProducts(inv.id);
      } catch (e) {
        console.warn(`  ⚠ failed to fetch products for invoice ${inv.id} (${mk}): ${e.message}`);
      }
      if (!products.length) continue; // pure WIP-billing invoice

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

      // Sales tax is an invoice-level field, not itemized per line —
      // add it as its own transparent line so the drill-down total
      // reconciles to the real invoice total.
      const taxAmt = Number(inv.salesTax) || 0;
      if (taxAmt > 0) {
        const hwSum = lineRecords.filter((r) => r.category === "Hardware/Equipment").reduce((s, r) => s + r.amount, 0);
        const cloudSum = lineRecords.filter((r) => r.category === "Cloud/Consumption").reduce((s, r) => s + r.amount, 0);
        const dominant = hwSum >= cloudSum ? "Hardware/Equipment" : "Cloud/Consumption";
        lineRecords.push({
          description: "Sales Tax",
          productIdentifier: null,
          quantity: null,
          unitPrice: null,
          extPrice: taxAmt,
          category: dominant,
          amount: Number(taxAmt.toFixed(2)),
        });
        byCategory[dominant] += taxAmt;
        totalSales += taxAmt;
        const c = byClientMap.get(company);
        if (dominant === "Cloud/Consumption") c.cloud += taxAmt;
        else c.hardware += taxAmt;
      }

      invoiceRecords.push({
        id: inv.id,
        date: inv.date,
        company,
        invoiceNumber: inv.invoiceNumber || null,
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

    const snapshot = {
      generatedAt: new Date().toISOString(),
      totalSales: Number(totalSales.toFixed(2)),
      byCategory: {
        "Hardware/Equipment": Number(byCategory["Hardware/Equipment"].toFixed(2)),
        "Cloud/Consumption": Number(byCategory["Cloud/Consumption"].toFixed(2)),
      },
      byClient,
      invoices: invoiceRecords,
      flagged: [],
      historical: true,
    };

    fs.writeFileSync(path.join(historyDir, `${mk}.json`), JSON.stringify(snapshot, null, 2));
    console.log(`  wrote data/sales/history/${mk}.json — total $${snapshot.totalSales}`);
  }

  const existing = fs.readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();

  let manifest = { months: existing, latest: existing[existing.length - 1] };
  const manifestPath = path.join(dataDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.latest = prior.latest || manifest.latest;
    } catch (e) {
      // fall through with reconstructed manifest
    }
  }
  manifest.generatedAt = new Date().toISOString();
  manifest.months = existing;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Updated data/sales/manifest.json — ${existing.length} months total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
