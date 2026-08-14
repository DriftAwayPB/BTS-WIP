/**
 * cw-wip-pull.js
 *
 * Pulls billable time entries from ConnectWise PSA for the current month
 * plus the previous HISTORY_MONTHS_BACK months, aggregates each month by
 * client and by day, and writes one file per month into data/, plus a
 * data/manifest.json listing which months are available.
 *
 * TIMEZONE FIX (this version): everything used to bucket dates by raw
 * UTC calendar day (via toISOString().split("T")[0]). Since this shop
 * runs on Eastern time, any entry logged after ~8pm Eastern had already
 * rolled into the next UTC day — showing up as "tomorrow" on the
 * dashboard. Every date computation below now resolves to the LOCAL
 * (America/New_York) calendar date instead, using Node's built-in
 * Intl.DateTimeFormat (no library needed, and it handles the EST/EDT
 * switch automatically). This affects: which day a time entry gets
 * bucketed into, which month is "the current month," what "today" is
 * for weekday-elapsed math, and weekday counting for the month.
 *
 * To make this safe against the UTC/local mismatch at the API-query
 * level too, each month's query window is padded by 1 day on either
 * side (Eastern is only 4-5 hours off UTC, so 1 day is always enough),
 * then entries are filtered back down to their real local month after
 * fetching — see aggregate()'s targetMonthKey filter.
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

const TZ = "America/New_York";

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

// ---------- Timezone-aware date helpers ----------

/** The real local (Eastern) calendar date for a given instant, as "YYYY-MM-DD". */
function localDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function ymKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

function ymdKey(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // pure calendar math, not an instant — TZ-independent
}

/**
 * Counts weekdays (Mon–Fri) in local calendar month y-m, from day 1
 * through uptoDay (or the whole month if uptoDay is omitted). Weekday
 * of a plain calendar date is timezone-independent once we already
 * have the correct local y/m/d — so this can safely use UTC getters
 * on a constructed calendar date without reintroducing the bug.
 */
function countWeekdaysInMonth(y, m, uptoDay) {
  const last = lastDayOfMonth(y, m);
  const endDay = uptoDay ? Math.min(uptoDay, last) : last;
  let count = 0;
  for (let d = 1; d <= endDay; d++) {
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return count;
}

/**
 * Fetches all billable time entries between two precise instants,
 * handling pagination. CW returns up to 1000 records per page.
 */
async function fetchBillableTimeEntries(start, end) {
  const conditions = encodeURIComponent(
    `timeStart>=[${start.toISOString()}] and timeStart<=[${end.toISOString()}] and billableOption='Billable'`
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
 * looks like. The real rule is binary:
 *   - Entry tied to an agreement (entry.agreement is set) -> $0 billable
 *     to the client, full stop. It shows up in agreementAmount instead.
 *   - No agreement -> extendedInvoiceAmount is the real billable value.
 */
function entryValue(entry) {
  if (entry.agreement) return 0;
  return Number(entry.extendedInvoiceAmount) || 0;
}

/**
 * Aggregates entries into daily/client totals, bucketing by each
 * entry's real LOCAL (Eastern) calendar date. targetMonthKey filters
 * out entries that only showed up because of the query padding (i.e.
 * they actually belong to the adjacent month once converted to local
 * time), so nothing leaks across a month boundary.
 */
function aggregate(entries, monthGoal, incrementsMap, targetMonthKey) {
  const byDate = new Map(); // "YYYY-MM-DD" -> total billed
  const byClient = new Map(); // client name -> total billed
  const byClientDate = new Map(); // client name -> Map("YYYY-MM-DD" -> { hours, billed })
  const flagged = [];
  let totalBilledHours = 0; // only counts entries with real $ value, not agreement-covered ($0) time

  for (const entry of entries) {
    const dateKey = localDateKey(new Date(entry.timeStart));
    if (!dateKey.startsWith(targetMonthKey)) continue; // padding leak from the adjacent month — skip

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
 *   2. Above that minimum, billing rounds UP to the nearest 0.25 hour.
 *   3. Work types with no special minimum just use the 0.25 rounding
 *      throughout.
 */
const SECONDARY_ROUNDING = 0.25;

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
 * Pulls and writes one month's file. `todayD` (local day-of-month) is
 * only meaningful for the current month (drives weekdaysElapsed); past
 * months are treated as fully closed — elapsed = total, remaining = 0.
 */
async function pullMonth({ y, m, isCurrentMonth, todayD, monthGoalsMap, incrementsMap }) {
  const key = ymKey(y, m);
  const goal = Number(monthGoalsMap[key] ?? MONTH_GOAL);
  const last = lastDayOfMonth(y, m);

  // Pad the UTC query window 1 day on each side of the LOCAL month
  // boundaries — Eastern entries near midnight can land on a different
  // UTC calendar day than their real local date, so this guarantees we
  // don't miss any. aggregate()'s targetMonthKey filter trims the
  // padding back off after fetching.
  const queryStart = new Date(Date.UTC(y, m - 1, 1) - 24 * 60 * 60 * 1000);
  const queryEnd = isCurrentMonth
    ? new Date(Date.now() + 24 * 60 * 60 * 1000)
    : new Date(Date.UTC(y, m - 1, last, 23, 59, 59) + 24 * 60 * 60 * 1000);

  console.log(`Pulling ${key} (local ${TZ}) — query window ${queryStart.toISOString()} → ${queryEnd.toISOString()}`);

  const entries = await fetchBillableTimeEntries(queryStart, queryEnd);
  console.log(`  fetched ${entries.length} billable time entries (before local-month filtering)`);

  const { dailyAccrual, clientBreakdown, flagged, totalBilledHours } = aggregate(entries, goal, incrementsMap, key);

  if (flagged.length) {
    console.warn(`  ⚠ ${flagged.length} entries had hours but no invoice amount — excluded, see flagged[]`);
  }

  const weekdaysInMonth = countWeekdaysInMonth(y, m);
  const weekdaysElapsed = isCurrentMonth ? countWeekdaysInMonth(y, m, todayD) : weekdaysInMonth;
  const weekdaysRemaining = weekdaysInMonth - weekdaysElapsed;
  const currentDate = isCurrentMonth ? ymdKey(y, m, todayD) : ymdKey(y, m, last);

  const output = {
    generatedAt: new Date().toISOString(),
    month: key,
    isCurrentMonth,
    monthGoal: goal,
    weekdaysInMonth,
    weekdaysElapsed,
    weekdaysRemaining,
    currentDate,
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
      localDate: localDateKey(new Date(e.timeStart)),
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

  const now = new Date();
  const todayKey = localDateKey(now); // correct LOCAL (Eastern) calendar date, fixes "which month/day is today"
  const [todayY, todayM, todayD] = todayKey.split("-").map(Number);
  console.log(`Local (${TZ}) today: ${todayKey} — UTC instant: ${now.toISOString()}`);

  const monthGoalsMap = parseMonthGoals();
  const incrementsMap = parseWorkTypeIncrements();
  const historyBack = Number(HISTORY_MONTHS_BACK ?? 2);

  const writtenKeys = [];
  for (let i = 0; i <= historyBack; i++) {
    let y = todayY;
    let m = todayM - i;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    const key = await pullMonth({
      y,
      m,
      isCurrentMonth: i === 0,
      todayD,
      monthGoalsMap,
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
