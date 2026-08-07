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
 *   WORK_TYPE_INCREMENTS  JSON object mapping work type name -> minimum
 *                        billing increment in hours, e.g.
 *                        {"Patching": 1, "On Site Regular": 1}. Any work
 *                        type not listed uses DEFAULT_BILLING_INCREMENT.
 *                        Entries round UP to the nearest increment (e.g.
 *                        0.02 actual hours at a 0.25 increment bills 0.25).
 *   DEFAULT_BILLING_INCREMENT  minimum billing increment in hours for any
 *                        work type not listed in WORK_TYPE_INCREMENTS
 *                        (default 0.25).
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
  WORK_TYPE_INCREMENTS,
  DEFAULT_BILLING_INCREMENT,
  DEBUG_COMPANY, // TEMPORARY — set to a client name substring to dump sample entries from them
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
 * Rate resolution — confirmed against ConnectWise's own Financial Recap
 * screen on a real Baird ticket (not guessed from field patterns this time):
 *
 * When a time entry is applied against an agreement, the ticket's
 * Financial Recap shows $0.00 billable — the ENTIRE amount sits in the
 * Agreement Recap instead, regardless of what `agreementAdjustment`
 * looks like. An earlier version of this function tried to net out a
 * proportional split using `agreementAdjustment`, based on a consistent
 * ~73% ratio seen across sample entries — that ratio turned out to be
 * some internal ConnectWise cost/margin figure, NOT a partial client
 * billing split. Checked directly against the ticket's own Financial
 * Recap and it was wrong. Don't reintroduce that without re-verifying
 * against a real ticket's Financial Recap again.
 *
 * The real rule is binary:
 *   - Entry tied to an agreement (entry.agreement is set) -> $0 billable
 *     to the client, full stop. It shows up in agreementAmount instead.
 *   - No agreement -> extendedInvoiceAmount is the real billable value.
 */
function entryValue(entry) {
  if (entry.agreement) return 0;
  return Number(entry.extendedInvoiceAmount) || 0;
}

function aggregate(entries, monthGoal, incrementsMap) {
  const byDate = new Map(); // "YYYY-MM-DD" -> total billed
  const byClient = new Map(); // client name -> total billed
  const byClientDate = new Map(); // client name -> Map("YYYY-MM-DD" -> { hours, billed })
  const flagged = [];
  let totalBilledHours = 0; // only counts entries with real $ value, not agreement-covered ($0) time

  for (const entry of entries) {
    const hours = entry.actualHours ?? entry.hoursBilled ?? 0;
    const gross = Number(entry.extendedInvoiceAmount) || 0;
    const value = entryValue(entry);

    if (hours > 0 && !gross) {
      // No resolved rate at all (gross is missing/zero) — worth checking
      // in ConnectWise. A $0 *net* value from full agreement coverage is
      // NOT flagged here — that's expected, not an error.
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
    if (!hours && !value) continue; // nothing meaningful to record

    const dateKey = isoDate(new Date(entry.timeStart));
    const client = entry.company?.name || "Unknown";
    const billedHours = billedHoursFor(entry, incrementsMap);

    byDate.set(dateKey, (byDate.get(dateKey) || 0) + value);
    byClient.set(client, (byClient.get(client) || 0) + value);
    if (value > 0) totalBilledHours += billedHours;

    if (!byClientDate.has(client)) byClientDate.set(client, new Map());
    const clientDates = byClientDate.get(client);
    const prior = clientDates.get(dateKey) || { hours: 0, billed: 0 };
    clientDates.set(dateKey, { hours: prior.hours + billedHours, billed: prior.billed + value });
  }

  const dailyAccrual = Array.from(byDate.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, accrued]) => ({ date, accrued: Math.round(accrued) }));

  const clientBreakdown = Array.from(byClient.entries())
    .map(([client, mtd]) => {
      const dates = byClientDate.get(client) || new Map();
      const daily = Array.from(dates.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, d]) => ({
          date,
          hours: Number(d.hours.toFixed(2)),
          billed: Math.round(d.billed),
        }));

      return {
        client,
        mtd: Math.round(mtd),
        pctOfGoal: Number(((mtd / monthGoal) * 100).toFixed(1)),
        daily,
      };
    })
    .sort((a, b) => b.mtd - a.mtd);

  return { dailyAccrual, clientBreakdown, flagged, totalBilledHours: Number(totalBilledHours.toFixed(2)) };
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

// Known minimum billing increments by work type, per the shop's actual
// billing rules. WORK_TYPE_INCREMENTS secret can override/extend this.
const DEFAULT_WORK_TYPE_INCREMENTS = {
  "Patching": 1,
  "On Site Regular": 1,
};

function parseWorkTypeIncrements() {
  let map = { ...DEFAULT_WORK_TYPE_INCREMENTS };
  if (WORK_TYPE_INCREMENTS) {
    try {
      map = { ...map, ...JSON.parse(WORK_TYPE_INCREMENTS) };
    } catch (e) {
      console.warn(`⚠ WORK_TYPE_INCREMENTS secret isn't valid JSON, using defaults only: ${e.message}`);
    }
  }
  return map;
}

const DEFAULT_INCREMENT = Number(DEFAULT_BILLING_INCREMENT ?? 0.25);

/**
 * Computes billed-equivalent hours for an entry, per the shop's actual
 * two-tier billing rule:
 *   1. Work types with a configured minimum (Patching, On Site Regular =
 *      1 hour) bill at that minimum for anything at or under it.
 *   2. Above that minimum, billing rounds UP to the nearest 0.25 hour —
 *      e.g. 1.3 actual hours on Patching bills as 1.5, not 1.3 and not 2.0.
 *   3. Work types with no special minimum just use the 0.25 rounding
 *      throughout (their "minimum" and "increment" are the same value),
 *      which collapses to the same behavior as before.
 */
const SECONDARY_ROUNDING = 0.25; // always the granularity once past the minimum

function billedHoursFor(entry, incrementsMap) {
  const actual = entry.actualHours ?? entry.hoursBilled ?? 0;
  if (actual <= 0) return 0;
  const workTypeName = entry.workType?.name || "";
  const minimum = incrementsMap[workTypeName] ?? DEFAULT_INCREMENT;

  if (actual <= minimum) return Number(minimum.toFixed(2));

  const units = Math.ceil(actual / SECONDARY_ROUNDING - 1e-9);
  return Number((units * SECONDARY_ROUNDING).toFixed(2));
}

/**
 * Pulls and writes one month's file. `today` is only meaningful for the
 * current month (drives weekdaysElapsed/weekdaysRemaining); past months are
 * treated as fully closed — elapsed = total, remaining = 0.
 */
async function pullMonth({ refDate, today, monthGoalsMap, isCurrentMonth, incrementsMap }) {
  const key = monthKey(refDate);
  const { start, end } = monthBounds(refDate);
  const goal = Number(monthGoalsMap[key] ?? MONTH_GOAL);

  console.log(`Pulling ${key}: ${isoDate(start)} → ${isoDate(isCurrentMonth ? today : end)}`);

  const entries = await fetchBillableTimeEntries(start, end);
  console.log(`  fetched ${entries.length} billable time entries`);

  const { dailyAccrual, clientBreakdown, flagged, totalBilledHours } = aggregate(entries, goal, incrementsMap);

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
    totalBilledHours,
  };

  if (DEBUG_COMPANY) {
    const matches = entries.filter((e) =>
      (e.company?.name || "").toLowerCase().includes(DEBUG_COMPANY.toLowerCase())
    );
    output._debugCompanyEntries = matches.slice(0, 5).map((e) => ({
      id: e.id,
      ticket: e.chargeToId,
      timeStart: e.timeStart,
      actualHours: e.actualHours,
      billableOption: e.billableOption,
      extendedInvoiceAmount: e.extendedInvoiceAmount,
      agreementAmount: e.agreementAmount,
      agreementAdjustment: e.agreementAdjustment,
      adjustment: e.adjustment,
      invoiceReady: e.invoiceReady,
      agreement: e.agreement || null,
      ticketBillingMethod: e.ticket?._info?.billingMethod || null,
    }));
    console.log(`  DEBUG: captured ${output._debugCompanyEntries.length} sample entries for "${DEBUG_COMPANY}"`);
  }

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
  const incrementsMap = parseWorkTypeIncrements();
  const historyBack = Number(HISTORY_MONTHS_BACK ?? 2);

  const writtenKeys = [];
  for (let i = 0; i <= historyBack; i++) {
    const refDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const key = await pullMonth({
      refDate,
      today,
      monthGoalsMap,
      isCurrentMonth: i === 0,
      incrementsMap,
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
