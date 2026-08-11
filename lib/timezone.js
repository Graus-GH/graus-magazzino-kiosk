/*
 * Timezone helpers for Europe/Rome.
 *
 * Vercel serverless functions run in UTC by default (no TZ env var set).
 * Using plain `new Date(); .setHours(0,0,0,0)` therefore computes MIDNIGHT
 * UTC, not midnight in Italy — during CEST (summer, UTC+2) that's 2 hours
 * off from real local midnight, which shows up as stop times, "today"
 * boundaries, and day-bucketed charts all being shifted.
 *
 * These helpers compute the actual Rome-local wall-clock boundaries,
 * correctly handling the CET/CEST DST switch.
 */

const ROME_TZ = "Europe/Rome";

// Current UTC offset for Rome, in minutes (e.g. 120 during CEST, 60 during CET)
function romeOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const rome = new Date(date.toLocaleString("en-US", { timeZone: ROME_TZ }));
  return Math.round((rome - utc) / 60000);
}

// Midnight today in Rome, returned as a real UTC-instant Date
function startOfDayRome(date = new Date()) {
  const offset = romeOffsetMinutes(date);
  const shifted = new Date(date.getTime() + offset * 60000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offset * 60000);
}

// Midnight on the 1st of the current month in Rome
function startOfMonthRome(date = new Date()) {
  const offset = romeOffsetMinutes(date);
  const shifted = new Date(date.getTime() + offset * 60000);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offset * 60000);
}

// "YYYY-MM-DD" for a given instant, in Rome's local calendar day
function dateKeyRome(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ROME_TZ }).format(date);
}

// Midnight for an arbitrary "YYYY-MM-DD" Rome-local date string
function startOfDateStringRome(dateStr) {
  // Treat the string as a Rome wall-clock date, find its UTC-instant midnight
  const noonUtc = new Date(dateStr + "T12:00:00Z"); // safely inside the same day regardless of offset
  return startOfDayRome(noonUtc);
}

module.exports = {
  romeOffsetMinutes,
  startOfDayRome,
  startOfMonthRome,
  dateKeyRome,
  startOfDateStringRome
};
