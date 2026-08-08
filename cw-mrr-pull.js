/**
 * cw-mrr-pull.js
 *
 * Pulls active ConnectWise agreements + their active additions, and
 * computes true normalized MRR split into "365 Licensing" vs "Managed
 * Services". Built from real field inspection (see the discovery-phase
 * debug files this replaced) rather than guesses:
 *
 *   - Agreement-level `billAmount` is $0 for almost everything — the real
 *     dollar amounts live on Additions (per-unit line items).
 *   - Each addition's `extPrice` (quantity × unitPrice) is the real
 *     billed value, at whatever billing cycle the PARENT agreement uses
 *     (additions don't carry their own cycle).
 *   - Additions have their own `additionStatus`, independent of the
 *     parent agreement's status — a "Cancelled" addition on an "Active"
 *     agreement must be excluded.
 *   - Categorization uses keyword matching against the addition's
 *     product identifier + description (confirmed cleanest signal),
 *     falling back to the agreement's own name/type for agreement-level
 *     billAmount (e.g. Block Time agreements).
 *
 * Writes:
 *   data/mrr/current.json           — latest snapshot
 *   data/mrr/history/YYYY-MM.json   — snapshot for the current month,
 *                                      overwritten on each run (so once
 *                                      a month closes, its file reflects
 *                                      the last pull of that month)
 *   data/mrr/manifest.json          — list of available history months
 *
 * Reuses the same ConnectWise secrets as cw-wip-pull.js:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 *
 * Optional:
 *   MRR_LICENSING_KEYWORDS   comma-separated, case-insensitive substrings
 *                            that mark an addition/agreement as "365
 *                            Licensing" rather than "Managed Services".
 *                            Default: "365,teams phones"
 *   DEBUG_MRR                set to "true" to include raw agreement/
 *                            addition dumps in current.json for
 *                            troubleshooting.
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
  DEBUG_MRR,
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

async function fetchAllAgreements() {
  let page = 1;
  const pageSize = 1000;
  const all = [];
  while (true) {
    const url = `${CW_BASE_URL}/finance/agreements?page=${page}&pageSize=${pageSize}`;
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

async function fetchAdditions(agreementId) {
  const url = `${CW_BASE_URL}/finance/agreements/${agreementId}/additions?pageSize=1000`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), clientId: CW_CLIENT_ID, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ConnectWise API error ${res.status} fetching additions for agreement ${agreementId}: ${body}`);
  }
  return res.json();
}

// Monthly-normalization factors by billing cycle name. Only "Monthly"
// and "Annual" confirmed against real data so far — anything else gets
// flagged rather than silently guessed at.
const CYCLE_FACTORS = {
  Monthly: 1,
  Annual: 1 / 12,
  Quarterly: 1 / 3,
  "Semi-Annually": 1 / 2,
};

function cycleFactorFor(agreement, flagged) {
  const cycleName = agreement.billingCycle?.name;
  if (cycleName && CYCLE_FACTORS[cycleName] !== undefined) {
    return CYCLE_FACTORS[cycleName];
  }
  flagged.push({
    agreementId: agreement.id,
    name: agreement.name,
    company: agreement.company?.name || null,
    issue: `Unknown/missing billing cycle "${cycleName}" — treated as Monthly (factor 1). Verify this agreement.`,
  });
  return 1;
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

async function main() {
  assertEnv();
  const keywords = parseLicensingKeywords();
  const debugMode = String(DEBUG_MRR).toLowerCase() === "true";

  console.log("Pulling ConnectWise agreements...");
  const allAgreements = await fetchAllAgreements();
  const activeAgreements = allAgreements.filter((a) => a.agreementStatus === "Active");
  console.log(`${allAgreements.length} total agreements, ${activeAgreements.length} active`);

  const flagged = [];
  const byCategory = { "365 Licensing": 0, "Managed Services": 0 };
  const byClientMap = new Map(); // company -> { licensing, managedServices }
  const agreementRecords = [];
  let totalMRR = 0;

  for (const a of activeAgreements) {
    const company = a.company?.name || "Unknown";
    const factor = cycleFactorFor(a, flagged);

    let additions = [];
    try {
      additions = await fetchAdditions(a.id);
    } catch (e) {
      console.warn(`  ⚠ failed to fetch additions for agreement ${a.id} (${a.name}): ${e.message}`);
      flagged.push({ agreementId: a.id, name: a.name, company, issue: `Failed to fetch additions: ${e.message}` });
    }
    const activeAdditions = additions.filter((add) => add.additionStatus === "Active");

    const additionRecords = [];
    for (const add of activeAdditions) {
      const monthlyAmt = (Number(add.extPrice) || 0) * factor;
      const category = categorize(`${add.description} ${add.product?.identifier || ""}`, keywords);
      additionRecords.push({
        description: add.description,
        productIdentifier: add.product?.identifier || null,
        quantity: add.billedQuantity ?? add.quantity ?? null,
        unitPrice: add.unitPrice ?? null,
        extPrice: add.extPrice ?? null,
        category,
        monthlyAmount: Number(monthlyAmt.toFixed(2)),
      });

      byCategory[category] += monthlyAmt;
      totalMRR += monthlyAmt;
      if (!byClientMap.has(company)) byClientMap.set(company, { licensing: 0, managedServices: 0 });
      const c = byClientMap.get(company);
      if (category === "365 Licensing") c.licensing += monthlyAmt;
      else c.managedServices += monthlyAmt;
    }

    // Agreement-level billAmount (Block Time agreements etc.) — categorize
    // off the agreement's own name/type since it's not an addition.
    const agreementBillMonthly = (Number(a.billAmount) || 0) * factor;
    if (agreementBillMonthly > 0) {
      const category = categorize(`${a.name} ${a.type?.name || ""}`, keywords);
      byCategory[category] += agreementBillMonthly;
      totalMRR += agreementBillMonthly;
      if (!byClientMap.has(company)) byClientMap.set(company, { licensing: 0, managedServices: 0 });
      const c = byClientMap.get(company);
      if (category === "365 Licensing") c.licensing += agreementBillMonthly;
      else c.managedServices += agreementBillMonthly;
    }

    agreementRecords.push({
      id: a.id,
      name: a.name,
      company,
      type: a.type?.name || null,
      billingCycle: a.billingCycle?.name || null,
      monthlyBillAmount: Number(agreementBillMonthly.toFixed(2)),
      additions: additionRecords,
      agreementMonthlyTotal: Number(
        (agreementBillMonthly + additionRecords.reduce((s, r) => s + r.monthlyAmount, 0)).toFixed(2)
      ),
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

  byCategory["365 Licensing"] = Number(byCategory["365 Licensing"].toFixed(2));
  byCategory["Managed Services"] = Number(byCategory["Managed Services"].toFixed(2));
  totalMRR = Number(totalMRR.toFixed(2));

  agreementRecords.sort((a, b) => b.agreementMonthlyTotal - a.agreementMonthlyTotal);

  if (flagged.length) {
    console.warn(`⚠ ${flagged.length} items flagged for review — see flagged[] in current.json`);
  }
  console.log(`Total MRR: $${totalMRR} (Licensing: $${byCategory["365 Licensing"]}, Managed Services: $${byCategory["Managed Services"]})`);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    totalMRR,
    byCategory,
    byClient,
    agreements: agreementRecords,
    flagged,
  };

  if (debugMode) {
    snapshot._debugRawAgreementCount = allAgreements.length;
    snapshot._debugActiveAgreementCount = activeAgreements.length;
  }

  const mrrDir = path.join(__dirname, "data", "mrr");
  const historyDir = path.join(mrrDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  fs.writeFileSync(path.join(mrrDir, "current.json"), JSON.stringify(snapshot, null, 2));

  const key = monthKey(new Date());
  fs.writeFileSync(path.join(historyDir, `${key}.json`), JSON.stringify(snapshot, null, 2));

  const existingHistory = fs.readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();

  fs.writeFileSync(
    path.join(mrrDir, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), months: existingHistory, latest: key }, null, 2)
  );

  console.log("Wrote data/mrr/current.json, data/mrr/history/" + key + ".json, and data/mrr/manifest.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
