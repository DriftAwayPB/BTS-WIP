/**
 * cw-invoice-discovery.js
 *
 * DISCOVERY SCRIPT — pulls real ConnectWise invoices from Jan 2025 to
 * present, to see the actual field shape before building MRR historical
 * backfill logic. Same approach as every other discovery pass in this
 * project: look at real data first, build against confirmed fields.
 *
 * Specifically trying to answer:
 *   - Do invoices distinguish agreement/recurring billing from regular
 *     time & material billing? Via what field?
 *   - What does an invoice's line-item detail actually look like —
 *     same shape as Additions (description, quantity, unitPrice), or
 *     something else?
 *   - Can we reliably map invoice line items back to a category (365
 *     Licensing vs Managed Services) the same way we did for Additions?
 *
 * Writes data/mrr/_debug-invoices.json — NOT used by the real dashboard,
 * just for us to review together.
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

async function fetchSampleUnfiltered(pageSize) {
  const url = `${CW_BASE_URL}/finance/invoices?pageSize=${pageSize}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), clientId: CW_CLIENT_ID, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ConnectWise API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchInvoices(startDate, endDate) {
  const conditions = encodeURIComponent(`invoiceDate>=[${startDate}] and invoiceDate<=[${endDate}]`);
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

async function fetchInvoiceDetail(invoiceId) {
  const url = `${CW_BASE_URL}/finance/invoices/${invoiceId}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), clientId: CW_CLIENT_ID, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ConnectWise API error ${res.status} fetching invoice ${invoiceId}: ${body}`);
  }
  return res.json();
}

function monthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : "unknown";
}

async function main() {
  assertEnv();

  console.log("Pulling a small unfiltered sample first to confirm real field names...");
  const sample = await fetchSampleUnfiltered(5);
  console.log(`Fetched ${sample.length} sample invoices (unfiltered)`);

  const dataDir = path.join(__dirname, "data", "mrr");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "_debug-invoices.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: "Field-discovery pass only — date-range pull not yet attempted, waiting to confirm the correct date field name.",
        sample,
      },
      null,
      2
    )
  );
  console.log("Wrote data/mrr/_debug-invoices.json (field-discovery sample only)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
