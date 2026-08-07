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

function isWeekday(date) {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day !== 0 && day !== 6;
}

/**
 * Counts weekdays (Mon–Fri) between two dates, inclusive on both ends.
 * Used instead of raw calendar days since this shop only bills weekdays —
 * a flat monthGoal / daysInMonth pace would understate the daily target
 * needed on the days that actually count.
 */
function countWeekdays(start, end) {
  let count = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= endDay) {
    if (isWeekday(cursor)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
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
 * Rate resolution — corrected based on this instance's actual API response:
 *
 * ConnectWise time entries here don't expose a flat `hourlyRate` field.
 * Instead, each entry carries `extendedInvoiceAmount` — the exact dollar
 * value ConnectWise has already computed for that entry, with the full
 * rate hierarchy (including your Company-specific Work Role overrides)
 * baked in. That means we don't need to multiply hours × rate ourselves
 * at all — we just sum extendedInvoiceAmount directly. This is more
 * accurate than a manual hours×rate calc would have been anyway, since
 * it reflects whatever rounding/minimum-increment rules ConnectWise
 * applies internally.
 *
 * `hourlyCost` on an entry is the member's internal cost rate — not a
 * billing figure, don't use it here (useful later for a margin view).
 *
 * Entries can still legitimately have $0 extendedInvoiceAmount despite
 * being marked Billable — e.g. entries not yet marked invoiceReady, or
 * a config gap. Those get flagged rather than silently counted as $0.
 */
function entryValue(entry) {
  return Number(entry.extendedInvoiceAmount) || 0;
}

function aggregate(entries, monthGoal) {
  const byDate = new Map(); // "YYYY-MM-DD" -> total
  const byClient = new Map(); // client name -> total
  const flagged = []; // entries with hours but no invoice amount

  for (const entry of entries) {
    const hours = entry.actualHours ?? entry.hoursBilled ?? 0;
    const value = entryValue(entry);

    if (hours > 0 && !value) {
      flagged.push({
        id: entry.id,
        ticket: entry.chargeToId,
        company: entry.company?.name || "Unknown",
        workRole: entry.workRole?.name || "Unknown",
        member: entry.member?.name || "Unknown",
        date: entry.timeStart,
        hours,
        invoiceReady: entry.invoiceReady,
      });
      continue; // excluded from totals — see flagged[] in output
    }
    if (!value) continue;

    const dateKey = isoDate(new Date(entry.timeStart));
    byDate.set(dateKey, (byDate.get(dateKey) || 0) + value);

    const client = entry.company?.name || "Unknown";
    byClient.set(client, (byClient.get(client) || 0) + value);
  }

  const dailyAccrual = Array.from(byDate.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, accrued]) => ({ date, accrued: Math.round(accrued) }));

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

  const { start, end, today } = monthBounds();
  console.log(`Pulling billable time entries ${isoDate(start)} → ${isoDate(today)}`);

  const entries = await fetchBillableTimeEntries(start, end);
  console.log(`Fetched ${entries.length} billable time entries`);

  const monthGoal = Number(MONTH_GOAL);
  const { dailyAccrual, clientBreakdown, flagged } = aggregate(entries, monthGoal);

  if (flagged.length) {
    console.warn(
      `⚠ ${flagged.length} billable time entries had hours but no resolved hourly rate — ` +
      `excluded from totals. These are worth checking in ConnectWise (missing rate config for ` +
      `that work role, or a Fixed Fee entry). See "flagged" in wip-data.json for details.`
    );
  }

  const weekdaysInMonth = countWeekdays(start, end);
  const weekdaysElapsed = countWeekdays(start, today);
  const weekdaysRemaining = weekdaysInMonth - weekdaysElapsed;

  const output = {
    generatedAt: new Date().toISOString(),
    monthGoal,
    weekdaysInMonth,
    weekdaysElapsed,
    weekdaysRemaining,
    currentDate: isoDate(today),
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
