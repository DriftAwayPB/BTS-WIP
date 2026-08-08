/**
 * cw-mrr-backfill.js
 *
 * Reconstructs historical MRR (Jan 2025 -> the month before the current
 * one) from real ConnectWise invoices, instead of guessing backward from
 * today's agreement/addition state. This is what actually solves the
 * "we can't see historical quantity changes" problem — each invoice is
 * a real, dated record of what was billed at that point in time.
 *
 * Confirmed from real data before writing this:
 *   - invoice.type === "Agreement" flags recurring agreement invoices
 *     (vs "Standard" for one-off billing) — plain string, not nested.
 *   - invoice.date is the real date field (not invoiceDate).
 *   - Line items come from a separate call:
 *     GET /procurement/products?conditions=invoice/id={id}
 *     Each item has description, catalogItem.identifier, quantity,
 *     price, extPrice — same shape as live Agreement Additions, so the
 *     same categorization keywords apply directly.
 *   - Some invoices (e.g. Block Time agreements) have serviceTotal
 *     instead of/alongside product line items — categorized off the
 *     agreement's own name/type, same as the live script does for
 *     agreement-level billAmount.
 *   - No cycle normalization needed here: each invoice already
 *     represents one real billing event, counted in the month it was
 *     actually invoiced.
 *
 * Does NOT touch the current (in-progress) month — that's still owned
 * by cw-mrr-pull.js's live agreement/addition snapshot. This script
 * only backfills data/mrr/history/YYYY-MM.json for CLOSED months.
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 * Optional: MRR_LICENSING_KEYWORDS (same as cw-mrr-pull.js)
 */

const fs = require("fs");
const path = require("path");

const {
  CW_BASE_URL,
  CW_COMPANY_ID,
  CW_PUBLIC_KEY,
  CW_PRIVATE_KEY,
  CW_CLIENT_ID,
  MRR_LICENSING_KEYWORDS,
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

async function fetchAgreementInvoices(startDate, endDate) {
  const conditions = encodeURIComponent(`type="Agreement" and date>=[${startDate}] and date<=[${endDate}]`);
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

const DEFAULT_LICENSING_KEYWORDS = ["365", "teams phones"];
function parseLicensingKeywords() {
  if (!MRR_LICENSING_KEYWORDS) return DEFAULT_LICENSING_KEYWORDS;
  return MRR_LICENSING_KEYWORDS.split(",").map((s) => s.trim()).filter(Boolean);
}

function categorize(text, keywords) {
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase())) ? "365 Licensing" : "Managed Services";
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
  const keywords = parseLicensingKeywords();
  const startDate = BACKFILL_START_DATE || "2025-01-01T00:00:00Z";
  const endDate = new Date().toISOString();
  const skipMonth = currentMonthKey(); // live script owns this one

  console.log(`Pulling Agreement-type invoices from ${startDate} to ${endDate}...`);
  const invoices = await fetchAgreementInvoices(startDate, endDate);
  console.log(`Fetched ${invoices.length} agreement invoices`);

  // Group invoices by month, skipping the current in-progress month.
  const byMonthInvoices = {};
  for (const inv of invoices) {
    const mk = monthKey(inv.date);
    if (mk === skipMonth) continue;
    if (!byMonthInvoices[mk]) byMonthInvoices[mk] = [];
    byMonthInvoices[mk].push(inv);
  }

  const months = Object.keys(byMonthInvoices).sort();
  console.log(`Backfilling ${months.length} closed months: ${months.join(", ")}`);

  const dataDir = path.join(__dirname, "data", "mrr");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  for (const mk of months) {
    const monthInvoices = byMonthInvoices[mk];
    let totalMRR = 0;
    const byCategory = { "365 Licensing": 0, "Managed Services": 0 };
    const byClientMap = new Map();
    const agreementRecords = [];

    for (const inv of monthInvoices) {
      const company = inv.company?.name || "Unknown";
      let products = [];
      try {
        products = await fetchInvoiceProducts(inv.id);
      } catch (e) {
        console.warn(`  ⚠ failed to fetch products for invoice ${inv.id} (${mk}): ${e.message}`);
      }

      const additionRecords = [];
      for (const p of products) {
        const amt = Number(p.extPrice) || 0;
        const category = categorize(`${p.description} ${p.catalogItem?.identifier || ""}`, keywords);
        additionRecords.push({
          description: p.description,
          productIdentifier: p.catalogItem?.identifier || null,
          quantity: p.quantity ?? null,
          unitPrice: p.price ?? null,
          extPrice: p.extPrice ?? null,
          category,
          monthlyAmount: Number(amt.toFixed(2)),
        });
        byCategory[category] += amt;
        totalMRR += amt;
        if (!byClientMap.has(company)) byClientMap.set(company, { licensing: 0, managedServices: 0 });
        const c = byClientMap.get(company);
        if (category === "365 Licensing") c.licensing += amt;
        else c.managedServices += amt;
      }

      // Service total (e.g. Block Time block-fee) — categorize off the
      // agreement's own name/type, same as the live script.
      const serviceAmt = Number(inv.serviceTotal) || 0;
      if (serviceAmt > 0) {
        const category = categorize(`${inv.agreement?.name || ""} ${inv.agreement?.type || ""}`, keywords);
        byCategory[category] += serviceAmt;
        totalMRR += serviceAmt;
        if (!byClientMap.has(company)) byClientMap.set(company, { licensing: 0, managedServices: 0 });
        const c = byClientMap.get(company);
        if (category === "365 Licensing") c.licensing += serviceAmt;
        else c.managedServices += serviceAmt;
      }

      agreementRecords.push({
        id: inv.id,
        name: inv.agreement?.name || null,
        company,
        type: inv.agreement?.type || null,
        billingCycle: null, // not resolvable per-invoice; each invoice is already a single real billing event
        monthlyBillAmount: Number(serviceAmt.toFixed(2)),
        additions: additionRecords,
        agreementMonthlyTotal: Number((serviceAmt + additionRecords.reduce((s, r) => s + r.monthlyAmount, 0)).toFixed(2)),
      });
    }

    const byClient = Array.from(byClientMap.entries())
      .map(([client, v]) => ({
        client,
        licensingMRR: Number(v.licensing.toFixed(2)),
        managedServicesMRR: Number(v.managedServices.toFixed(2)),
        totalMRR: Number((v.licensing + v.managedServices).toFixed(2)),
      }))
      .sort((a, b) => b.totalMRR - a.totalMRR);

    agreementRecords.sort((a, b) => b.agreementMonthlyTotal - a.agreementMonthlyTotal);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      totalMRR: Number(totalMRR.toFixed(2)),
      byCategory: {
        "365 Licensing": Number(byCategory["365 Licensing"].toFixed(2)),
        "Managed Services": Number(byCategory["Managed Services"].toFixed(2)),
      },
      byClient,
      agreements: agreementRecords,
      flagged: [],
      historical: true, // reconstructed from real invoices, not current-state agreements
    };

    fs.writeFileSync(path.join(historyDir, `${mk}.json`), JSON.stringify(snapshot, null, 2));
    console.log(`  wrote data/mrr/history/${mk}.json — total $${snapshot.totalMRR}`);
  }

  // Update manifest with every month now present (backfilled + live)
  const existing = fs.readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();

  let manifest = { months: existing, latest: existing[existing.length - 1] };
  const manifestPath = path.join(dataDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.latest = prior.latest || manifest.latest; // keep the live script's idea of "latest"
    } catch (e) {
      // fall through with reconstructed manifest
    }
  }
  manifest.generatedAt = new Date().toISOString();
  manifest.months = existing;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Updated data/mrr/manifest.json — ${existing.length} months total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
