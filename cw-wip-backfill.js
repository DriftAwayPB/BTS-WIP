/**
 * cw-wip-backfill.js
 *
 * Reconstructs historical WIP data (Jan 2025 -> last month) into
 * data/YYYY-MM.json, using the exact same timezone-corrected logic as
 * cw-wip-pull.js (local Eastern calendar-date bucketing, not raw UTC —
 * see that file's header for the full explanation). Built after that
 * fix, so this history is correct from day one — no separate patch
 * needed later.
 *
 * Skips only the CURRENT month (owned by the live pull). Re-covers
 * whatever recent months the live pull's rolling window already
 * handles too — harmless, since both use identical logic and will
 * produce matching results; whichever ran most recently just wins.
 *
 * Historical months are treated as fully closed: weekdaysElapsed =
 * weekdaysInMonth, weekdaysRemaining = 0, currentDate = last day of
 * that month.
 *
 * Reuses the same ConnectWise secrets as the other pull scripts:
 *   CW_BASE_URL, CW_COMPANY_ID, CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
 * Optional: MONTH_GOALS, WORK_TYPE_INCREMENTS, DEFAULT_BILLING_INCREMENT
 *           (same as cw-wip-pull.js), BACKFILL_START (default "2025-01")
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
  WORK_TYPE_INCREMENTS,
  DEFAULT_BILLING_INCREMENT,
  BACKFILL_START,
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
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

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
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

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

function entryValue(entry) {
  if (entry.agreement) return 0;
  return Number(entry.extendedInvoiceAmount) || 0;
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

const DEFAULT_WORK_TYPE_INCREMENTS = { "Patching": 1, "On Site Regular": 1 };
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

function aggregate(entries, monthGoal, incrementsMap, targetMonthKey) {
  const byDate = new Map();
  const byClient = new Map();
  const byClientDate = new Map();
  const flagged = [];
  let totalBilledHours = 0;

  for (const entry of entries) {
    const dateKey = localDateKey(new Date(entry.timeStart));
    if (!dateKey.startsWith(targetMonthKey)) continue;

    const hours = entry.actualHours ?? entry.hoursBilled ?? 0;
    const gross = Number(entry.extendedInvoiceAmount) || 0;
    const value = entryValue(entry);

    if (hours > 0 && !gross) {
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
    if (!hours && !value) continue;

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
        .map(([date, d]) => ({ date, hours: Number(d.hours.toFixed(2)), billed: Math.round(d.billed) }));
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

async function backfillMonth(y, m, monthGoalsMap, incrementsMap) {
  const key = ymKey(y, m);
  const goal = Number(monthGoalsMap[key] ?? MONTH_GOAL);
  const last = lastDayOfMonth(y, m);

  const queryStart = new Date(Date.UTC(y, m - 1, 1) - 24 * 60 * 60 * 1000);
  const queryEnd = new Date(Date.UTC(y, m - 1, last, 23, 59, 59) + 24 * 60 * 60 * 1000);

  console.log(`Backfilling ${key} — query window ${queryStart.toISOString()} → ${queryEnd.toISOString()}`);
  const entries = await fetchBillableTimeEntries(queryStart, queryEnd);
  console.log(`  fetched ${entries.length} billable time entries (before local-month filtering)`);

  const { dailyAccrual, clientBreakdown, flagged, totalBilledHours } = aggregate(entries, goal, incrementsMap, key);
  if (flagged.length) {
    console.warn(`  ⚠ ${flagged.length} entries had hours but no invoice amount — excluded, see flagged[]`);
  }

  const weekdaysInMonth = countWeekdaysInMonth(y, m);

  const output = {
    generatedAt: new Date().toISOString(),
    month: key,
    isCurrentMonth: false,
    monthGoal: goal,
    weekdaysInMonth,
    weekdaysElapsed: weekdaysInMonth,
    weekdaysRemaining: 0,
    currentDate: ymdKey(y, m, last),
    dailyAccrual,
    clientBreakdown,
    flagged,
    totalBilledHours,
    historical: true,
  };

  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${key}.json`), JSON.stringify(output, null, 2));
  console.log(`  wrote data/${key}.json — MTD $${dailyAccrual.reduce((s, d) => s + d.accrued, 0)}`);
  return key;
}

async function main() {
  assertEnv();
  const monthGoalsMap = parseMonthGoals();
  const incrementsMap = parseWorkTypeIncrements();

  const now = new Date();
  const todayKey = localDateKey(now);
  const [todayY, todayM] = todayKey.split("-").map(Number);
  const currentMonthKey = ymKey(todayY, todayM);

  const startKey = BACKFILL_START || "2025-01";
  const [startY, startM] = startKey.split("-").map(Number);

  const months = [];
  let y = startY, m = startM;
  while (ymKey(y, m) !== currentMonthKey) {
    months.push({ y, m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (y > todayY + 1) break; // safety valve against runaway loop
  }

  console.log(`Backfilling ${months.length} months: ${months.map(({ y, m }) => ymKey(y, m)).join(", ")}`);

  const writtenKeys = [];
  for (const { y, m } of months) {
    const key = await backfillMonth(y, m, monthGoalsMap, incrementsMap);
    writtenKeys.push(key);
  }

  const dataDir = path.join(__dirname, "data");
  const existing = fs.readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""));
  const allMonths = Array.from(new Set([...existing, ...writtenKeys])).sort();

  let latest = allMonths[allMonths.length - 1];
  const manifestPath = path.join(dataDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (prior.latest) latest = prior.latest; // keep the live pull's idea of "latest" (current month)
    } catch (e) {
      // fall through with reconstructed value
    }
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), months: allMonths, latest }, null, 2)
  );
  console.log(`Wrote data/manifest.json (${allMonths.length} months total)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
