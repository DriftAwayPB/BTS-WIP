/**
 * cw-mrr-pull.js
 *
 * Pulls the CURRENT month's real Agreement-type invoices (same method as
 * cw-mrr-backfill.js) instead of reconstructing from live agreement/
 * addition state. This replaces an earlier version of this script that
 * used current agreement state + cycle-normalization (÷12 for annual
 * agreements) — that approach didn't match real ConnectWise invoicing,
 * since annual agreements actually bill in a single lump on their
 * renewal month, not smoothed evenly. Actual-as-billed is simpler and
 * matches what you see in ConnectWise directly.
 *
 * Trade-off this creates: ConnectWise invoices land in batches (this
 * shop's pattern: around the 1st and the 15th), so early in the month
 * "actual" is genuinely incomplete — clients who bill on the 15th just
 * haven't been invoiced yet. To handle that without guessing at
 * ConnectWise's internal invoice-scheduling behavior (nextInvoiceDate's
 * update timing isn't verified), this script also writes a `projected`
 * figure: for each client, use their real actual amount if they've
 * already invoiced this month, otherwise fall back to their amount
 * from last month as a placeholder. Simple, verifiable, no assumptions
 * about *when* ConnectWise will actually generate an invoice.
 *
 * Writes:
 *   data/mrr/current.json           — latest snapshot (current month)
 *   data/mrr/history/YYYY-MM.json   — same snapshot, filed by month
 *   data/mrr/manifest.json          — list of available history months
 *
 * Reuses the same ConnectWise secrets as cw-wip-pull.js:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 *
 * Optional:
 *   MRR_LICENSING_KEYWORDS   comma-separated, case-insensitive substrings
 *                            that mark a line item as "365 Licensing"
 *                            rather than "Managed Services".
 *                            Default: "365,teams phones"
 */

const fs = require("fs");
const path = require("path");

const { CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID, MRR_LICENSING_KEYWORDS } =
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

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function prevMonthKey(d) {
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return monthKey(prev);
}

function isoDate(d) {
  return d.toISOString().split("T")[0];
}

/**
 * Builds the "actual" snapshot for a set of Agreement-type invoices —
 * same categorization/aggregation logic as cw-mrr-backfill.js.
 */
async function buildActualFromInvoices(invoices, keywords) {
  const byCategory = { "365 Licensing": 0, "Managed Services": 0 };
  const byClientMap = new Map();
  const agreementRecords = [];
  let totalMRR = 0;

  for (const inv of invoices) {
    const company = inv.company?.name || "Unknown";
    let products = [];
    try {
      products = await fetchInvoiceProducts(inv.id);
    } catch (e) {
      console.warn(`  ⚠ failed to fetch products for invoice ${inv.id}: ${e.message}`);
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
      billingCycle: null,
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

  return {
    totalMRR: Number(totalMRR.toFixed(2)),
    byCategory: {
      "365 Licensing": Number(byCategory["365 Licensing"].toFixed(2)),
      "Managed Services": Number(byCategory["Managed Services"].toFixed(2)),
    },
    byClient,
    agreements: agreementRecords,
  };
}

/**
 * Hybrid projection: for each client, use their real actual amount if
 * they've already invoiced this month; otherwise fall back to last
 * month's actual amount for that client as a placeholder. This doesn't
 * try to predict *when* ConnectWise will generate an invoice — it just
 * assumes "probably similar to last month" for whatever hasn't landed
 * yet, which recurring agreements generally are.
 */
function buildProjection(actualByClient, prevMonthData) {
  const actualMap = new Map(actualByClient.map((c) => [c.client, c]));
  const prevByClient = prevMonthData?.byClient || [];
  const projectedMap = new Map();

  // Start from last month's clients as the baseline
  for (const c of prevByClient) {
    projectedMap.set(c.client, { client: c.client, licensingMRR: c.licensingMRR, managedServicesMRR: c.managedServicesMRR, totalMRR: c.totalMRR, source: "last_month" });
  }
  // Overlay this month's real actuals wherever they exist (including new clients)
  for (const c of actualByClient) {
    projectedMap.set(c.client, { client: c.client, licensingMRR: c.licensingMRR, managedServicesMRR: c.managedServicesMRR, totalMRR: c.totalMRR, source: "actual" });
  }

  const byClient = Array.from(projectedMap.values()).sort((a, b) => b.totalMRR - a.totalMRR);
  const byCategory = { "365 Licensing": 0, "Managed Services": 0 };
  let totalMRR = 0;
  for (const c of byClient) {
    byCategory["365 Licensing"] += c.licensingMRR;
    byCategory["Managed Services"] += c.managedServicesMRR;
    totalMRR += c.totalMRR;
  }

  return {
    totalMRR: Number(totalMRR.toFixed(2)),
    byCategory: {
      "365 Licensing": Number(byCategory["365 Licensing"].toFixed(2)),
      "Managed Services": Number(byCategory["Managed Services"].toFixed(2)),
    },
    byClient,
    basis: prevMonthData ? "actual where invoiced, last month's amount elsewhere" : "actual only — no prior month on file yet",
  };
}

async function main() {
  assertEnv();
  const keywords = parseLicensingKeywords();
  const today = new Date();
  const key = monthKey(today);
  const monthStart = `${key}-01T00:00:00Z`;

  console.log(`Pulling current-month (${key}) Agreement invoices, ${monthStart} → ${today.toISOString()}...`);
  const invoices = await fetchAgreementInvoices(monthStart, today.toISOString());
  console.log(`Fetched ${invoices.length} invoices so far this month`);

  const actual = await buildActualFromInvoices(invoices, keywords);

  const dataDir = path.join(__dirname, "data", "mrr");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  const prevKey = prevMonthKey(today);
  const prevPath = path.join(historyDir, `${prevKey}.json`);
  let prevMonthData = null;
  if (fs.existsSync(prevPath)) {
    try {
      prevMonthData = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    } catch (e) {
      console.warn(`⚠ couldn't read previous month's file (${prevKey}.json) for projection: ${e.message}`);
    }
  } else {
    console.warn(`⚠ no previous month file found at ${prevPath} — projection will just equal actual`);
  }

  const projected = buildProjection(actual.byClient, prevMonthData);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    isCurrentMonth: true,
    currentDate: isoDate(today),
    totalMRR: actual.totalMRR,
    byCategory: actual.byCategory,
    byClient: actual.byClient,
    agreements: actual.agreements,
    flagged: [],
    projected,
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
  console.log(`Actual so far: $${actual.totalMRR} — Projected: $${projected.totalMRR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
