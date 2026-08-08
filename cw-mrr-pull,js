/**
 * cw-mrr-pull.js
 *
 * DISCOVERY SCRIPT — pulls raw ConnectWise Agreements data so we can see
 * the actual field structure (type names, billing frequency, statuses)
 * before building real MRR aggregation and categorization logic. Same
 * approach that caught the Baird agreement-coverage issue on the WIP
 * side: look at real data first, build logic against confirmed fields,
 * not assumptions.
 *
 * Writes data/mrr/_debug-agreements.json — a raw/summarized dump, NOT
 * the final MRR data shape. This file gets replaced once we've reviewed
 * it together and settled on:
 *   - how to categorize agreements (e.g. "365 Licensing" vs "Managed
 *     Services") — by type, name pattern, or something else
 *   - how to normalize non-monthly billing (annual/quarterly) into a
 *     true monthly figure
 *   - which statuses count as "active" MRR vs cancelled/expired
 *
 * Reuses the same ConnectWise secrets as cw-wip-pull.js:
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

async function fetchAllAgreements() {
  let page = 1;
  const pageSize = 1000;
  const all = [];
  while (true) {
    const url = `${CW_BASE_URL}/finance/agreements?page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        clientId: CW_CLIENT_ID,
        Accept: "application/json",
      },
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

async function main() {
  assertEnv();
  console.log("Pulling all ConnectWise agreements for review...");
  const agreements = await fetchAllAgreements();
  console.log(`Fetched ${agreements.length} agreements`);

  // Quick summary so the counts are visible right in the Actions log too
  const byType = {};
  const byStatus = {};
  for (const a of agreements) {
    const typeName = a.type?.name || "Unknown";
    const status = a.agreementStatus || (a.cancelledFlag ? "Cancelled" : "Unknown");
    byType[typeName] = (byType[typeName] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  console.log("By type:", JSON.stringify(byType, null, 2));
  console.log("By status:", JSON.stringify(byStatus, null, 2));

  // A slim summary row per agreement using field names that are common
  // on ConnectWise Agreement objects — worth cross-checking against the
  // full raw samples below rather than trusting this blindly.
  const slim = agreements.map((a) => ({
    id: a.id,
    name: a.name,
    company: a.company?.name || null,
    type: a.type?.name || null,
    agreementStatus: a.agreementStatus || null,
    cancelledFlag: a.cancelledFlag ?? null,
    billingCycle: a.billingCycle || null,
    billAmount: a.billAmount ?? null,
    startDate: a.startDate || null,
    endDate: a.endDate || null,
    noEndingDateFlag: a.noEndingDateFlag ?? null,
  }));

  // Full, unfiltered raw objects for a handful of agreements — this is
  // what actually settles which field names are real vs. guessed.
  const rawSamples = agreements.slice(0, 8);

  const dataDir = path.join(__dirname, "data", "mrr");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "_debug-agreements.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: agreements.length,
        byType,
        byStatus,
        slim,
        rawSamples,
      },
      null,
      2
    )
  );
  console.log("Wrote data/mrr/_debug-agreements.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
