import "server-only";
import { CSV_ROW_LIMIT } from "@/lib/analytics/types";

// CSV downloads for the analytics exports. Columns are fixed by the caller
// and always written in the same order. Text cells are quoted, and any that
// a spreadsheet could read as a formula (starting with = + - @, a tab or a
// carriage return) get a leading apostrophe. Numbers are written as plain
// integers. Rows beyond CSV_ROW_LIMIT are cut, and the response says so.

export type CsvValue = string | number | null;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(columns: readonly string[], rows: readonly CsvValue[][]): string {
  const lines = [columns.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * A CSV attachment. `truncated` adds X-Truncated (and the screen shows the
 * limit); the body starts with a byte-order mark so spreadsheets read UTF-8.
 */
export function csvResponse(filename: string, columns: readonly string[], rows: readonly CsvValue[][], truncated = false) {
  const shown = rows.slice(0, CSV_ROW_LIMIT);
  const headers = new Headers({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, "_")}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Row-Limit": String(CSV_ROW_LIMIT),
    "X-Truncated": String(truncated || rows.length > CSV_ROW_LIMIT),
  });
  return new Response(`﻿${toCsv(columns, shown)}`, { status: 200, headers });
}
