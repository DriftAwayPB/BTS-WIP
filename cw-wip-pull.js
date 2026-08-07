/**
 * cw-wip-pull.js
 *
 * Pulls billable time entries from ConnectWise PSA for the current month,
 * aggregates them by client and by day, and writes wip-data.json in the
 * shape the WIP dashboard expects.
 *
 * Run manually:   node cw-wip-pull.js
 * Run in CI:       see .github/workflows/pull-wip.yml
 *
 * Required environment variables (set as GitHub Actions secrets in prod):
 *   CW_BASE_URL     e.g. https://api-na.myconnectwise.net/v4_6_release/apis/3.0
 *   CW_COMPANY_ID   your ConnectWise company/site identifier
 *   CW_PUBLIC_KEY   API member public key
 *   CW_PRIVATE_KEY  API member private key
 *   CW_CLIENT_ID    Client ID (GUID) registered at developer.connectwise.com
 *   MONTH_GOAL      this month's revenue goal, in dollars, e.g. 135000
 */

const fs = require("fs");
const path = require("path");

const {
  CW_BASE_URL,
  CW_COMPANY_ID,
  CW_PUBLIC_KEY,
  CW_PRIVATE_KEY,
  CW_CLIENT_ID,
  MONTH_GOAL,
} = process.env;

function assertEnv() {
  const required = ["CW_BASE_URL", "CW_COMPANY_ID", "CW_PUBLIC_KEY", "CW_PRIVATE_KEY", "CW_CLIENT_ID", "MONTH_GOAL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function authHeader() {
  const raw = `${CW_COMPANY_ID}+${CW_PUBLIC_KEY}:${CW_PRIVATE_KEY}`;
  const encoded = Buffer.from(raw).toString("base64");
  return `Basic ${encoded}`;
}

function monthBounds(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
  const daysInMonth = end.getUTCDate();
  return { start, end, daysInMonth, today: date };
}

function isoDate(d) {
  return d.toISOString().split("T")[0];
}

/**
 * Fetches all billable time entries between start and end, handling pagination.
 * CW returns up to 1000 records per page.
 */
async function fetchBillableTimeEntries(start, end) {
  const conditions = encodeURIComponent(
    `timeStart>=[${isoDate(start)}T00:00:00Z] and timeStart<=[${isoDate(end)}T23:59:59Z] and billableOption='Billable'`
  );

  let page = 1;
  const pageSize = 1000;
  const all = [];

  while (true) {
    const url = `${CW_BASE_URL}/time/entries?conditions=${conditions}&page=${page}&pageSize=${pageSize}`;
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

/**
 * Rate resolution — how this actually works:
 *
 * ConnectWise resolves the full billing-rate hierarchy (Member default ->
 * Work Role default -> Agreement Work Role override -> Company-specific
 * Work Role rate -> ticket/project overrides -> manual override) at the
 * moment a time entry is SAVED, and writes the final resolved number into
 * the entry's `hourlyRate` field. That means a client-specific rate you've
 * set up under Company > Track > Work Roles is already baked into
 * `entry.hourlyRate` by the time it reaches this script — we don't need
 * to re-implement that lookup ourselves.
 *
 * Where this can legitimately be missing:
 *   - Entries tied to Fixed Fee billing (no per-hour rate applies)
 *   - Old entries saved before a rate was configured for that work role
 *   - Entries where the tech picked a work role with no rate set anywhere
 *     in the hierarchy (a config gap worth fixing in CW, not papering
 *     over here)
 *
 * Rather than silently treating those as $0 (which would just make WIP
 * look artificially low), this script flags them separately so you can
 * go look at the actual entries in ConnectWise.
 */
function entryValue(entry) {
  const hours = entry.actualHours ?? entry.hoursBilled ?? 0;
  const rate = entry.hourlyRate ?? 0;
  return hours * rate;
}

function aggregate(entries, monthGoal, daysInMonth) {
  const byDay = new Map(); // "1".."31" -> total
  const byClient = new Map(); // client name -> total
  const flagged = []; // entries with hours but no resolved rate

  for (const entry of entries) {
    const hours = entry.actualHours ?? entry.hoursBilled ?? 0;
    const value = entryValue(entry);

    if (hours > 0 && !entry.hourlyRate) {
      flagged.push({
        id: entry.id,
        ticket: entry.chargeToId,
        company: entry.company?.name || "Unknown",
        workRole: entry.workRole?.name || "Unknown",
        member: entry.member?.name || "Unknown",
        date: entry.timeStart,
        hours,
      });
      continue; // excluded from totals — see flagged[] in output
    }
    if (!value) continue;

    const day = new Date(entry.timeStart).getUTCDate();
    byDay.set(day, (byDay.get(day) || 0) + value);

    const client = entry.company?.name || "Unknown";
    byClient.set(client, (byClient.get(client) || 0) + value);
  }

  const dailyAccrual = Array.from(byDay.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, accrued]) => ({ day, accrued: Math.round(accrued) }));

  const clientBreakdown = Array.from(byClient.entries())
    .map(([client, mtd]) => ({
      client,
      mtd: Math.round(mtd),
      pctOfGoal: Number(((mtd / monthGoal) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.mtd - a.mtd);

  return { dailyAccrual, clientBreakdown, flagged };
}

async function main() {
  assertEnv();

  const { start, end, daysInMonth, today } = monthBounds();
  console.log(`Pulling billable time entries ${isoDate(start)} → ${isoDate(today)}`);

  const entries = await fetchBillableTimeEntries(start, end);
  console.log(`Fetched ${entries.length} billable time entries`);

  const monthGoal = Number(MONTH_GOAL);
  const { dailyAccrual, clientBreakdown, flagged } = aggregate(entries, monthGoal, daysInMonth);

  if (flagged.length) {
    console.warn(
      `⚠ ${flagged.length} billable time entries had hours but no resolved hourly rate — ` +
      `excluded from totals. These are worth checking in ConnectWise (missing rate config for ` +
      `that work role, or a Fixed Fee entry). See "flagged" in wip-data.json for details.`
    );
  }

  const output = {
    generatedAt: new Date().toISOString(),
    monthGoal,
    daysInMonth,
    currentDay: today.getUTCDate(),
    dailyAccrual,
    clientBreakdown,
    flagged,
  };

  const outPath = path.join(__dirname, "wip-data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
