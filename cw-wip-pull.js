/**
 * cw-wip-pull.js
 *
 * Pulls billable time entries from ConnectWise PSA for the current month
 * plus the previous HISTORY_MONTHS_BACK months, aggregates each month by
 * client and by day, and writes one file per month into data/, plus a
 * data/manifest.json listing which months are available. The dashboard
 * reads the manifest to populate month navigation, then fetches whichever
 * month's file it needs.
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
 *   MONTH_GOAL      current month's revenue goal, in dollars, e.g. 24000 —
 *                   used as the goal for every month unless overridden below
 *
 * Optional:
 *   MONTH_GOALS     JSON object mapping "YYYY-MM" -> goal, to set different
 *                   goals for past months, e.g. {"2026-07": 21000}. Any
 *                   month not listed falls back to MONTH_GOAL.
 *   HISTORY_MONTHS_BACK  how many months of history to keep regenerating
 *                        besides the current month (default 2, so 3 months
 *                        total end up in data/).
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
  MONTH_GOALS,
  HISTORY_MONTHS_BACK,
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

function isoDate(d) {
  return d.toISOString().split("T")[0];
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(refDate) {
  const start = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth() + 1, 0, 23, 59, 59));
  return { start, end };
}

function isWeekday(date) {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day !== 0 && day !== 6;
}

/**
 * Counts weekdays (Mon–Fri) between two dates, inclusive on both ends.
 * Used instead of raw calendar days since this shop only bills weekdays.
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
 * Rate resolution: this instance's time entries carry `extendedInvoiceAmount`
 * — the exact resolved dollar value per entry, rate hierarchy already baked
 * in. We sum that directly rather than hours × rate.
 */
function entryValue(entry) {
  return Number(entry.extendedInvoiceAmount) || 0;
}

function aggregate(entries, monthGoal) {
  const byDate = new Map(); // "YYYY-MM-DD" -> total
  const byClient = new Map(); // client name -> total
  const flagged = [];

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
      continue;
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

function parseMonthGoals() {
  if (!MONTH_GOALS) return {};
  try {
    return JSON.parse(MONTH_GOALS);
  } catch (e) {
    console.warn(`⚠ MONTH_GOALS secret isn't valid JSON, ignoring it: ${e.message}`);
    return {};
  }
}

/**
 * Pulls and writes one month's file. `today` is only meaningful for the
 * current month (drives weekdaysElapsed/weekdaysRemaining); past months are
 * treated as fully closed — elapsed = total, remaining = 0.
 */
async function pullMonth({ refDate, today, monthGoalsMap, isCurrentMonth }) {
  const key = monthKey(refDate);
  const { start, end } = monthBounds(refDate);
  const goal = Number(monthGoalsMap[key] ?? MONTH_GOAL);

  console.log(`Pulling ${key}: ${isoDate(start)} → ${isoDate(isCurrentMonth ? today : end)}`);

  const entries = await fetchBillableTimeEntries(start, end);
  console.log(`  fetched ${entries.length} billable time entries`);

  const { dailyAccrual, clientBreakdown, flagged } = aggregate(entries, goal);

  if (flagged.length) {
    console.warn(`  ⚠ ${flagged.length} entries had hours but no invoice amount — excluded, see flagged[]`);
  }

  const weekdaysInMonth = countWeekdays(start, end);
  const weekdaysElapsed = isCurrentMonth ? countWeekdays(start, today) : weekdaysInMonth;
  const weekdaysRemaining = weekdaysInMonth - weekdaysElapsed;

  const output = {
    generatedAt: new Date().toISOString(),
    month: key,
    isCurrentMonth,
    monthGoal: goal,
    weekdaysInMonth,
    weekdaysElapsed,
    weekdaysRemaining,
    currentDate: isoDate(isCurrentMonth ? today : end),
    dailyAccrual,
    clientBreakdown,
    flagged,
  };

  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${key}.json`), JSON.stringify(output, null, 2));
  console.log(`  wrote data/${key}.json`);

  return key;
}

async function main() {
  assertEnv();

  const today = new Date();
  const monthGoalsMap = parseMonthGoals();
  const historyBack = Number(HISTORY_MONTHS_BACK ?? 2);

  const writtenKeys = [];
  for (let i = 0; i <= historyBack; i++) {
    const refDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const key = await pullMonth({
      refDate,
      today,
      monthGoalsMap,
      isCurrentMonth: i === 0,
    });
    writtenKeys.push(key);
  }

  // Manifest also picks up any older month files already sitting in data/
  // from previous runs, so history keeps accumulating beyond historyBack.
  const dataDir = path.join(__dirname, "data");
  const existing = fs.readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""));

  const allMonths = Array.from(new Set([...existing, ...writtenKeys])).sort();

  const manifest = {
    generatedAt: new Date().toISOString(),
    months: allMonths,
    latest: writtenKeys[0], // current month
  };
  fs.writeFileSync(path.join(dataDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Wrote data/manifest.json (${allMonths.length} months: ${allMonths.join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
