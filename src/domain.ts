import type { Brand } from "effect";

export type Cents = number & Brand.Brand<"Cents">;
export type Milliunits = number & Brand.Brand<"Milliunits">;
export type CalendarDate = string & Brand.Brand<"CalendarDate">;
export type SatispayTransactionId = string & Brand.Brand<"SatispayTransactionId">;
export type YnabAccountId = string & Brand.Brand<"YnabAccountId">;
export type YnabPlanId = string & Brand.Brand<"YnabPlanId">;

// Constructors are pure. Casts live only here, after validating the invariant.
export const makeCents = (value: number): Cents | null =>
  Number.isSafeInteger(value) ? (value as Cents) : null;
export const makeMilliunits = (value: number): Milliunits | null =>
  Number.isSafeInteger(value) ? (value as Milliunits) : null;
export const centsToMilliunits = (value: Cents): Milliunits | null => makeMilliunits(value * 10);
export const negateCents = (value: Cents): Cents => -value as Cents;

/**
 * A number, or Italian amount text
 * (`-12,50`, `+1.234,56`, `€ 9,90`, `(12,50)`).
 */
export function parseLocalizedNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value
    .trim()
    .replace(/\s|\u00a0|€/g, "")
    .replace(/−/g, "-");
  if (!s) return null;
  const parenthesized = /^\(.*\)$/.test(s);
  if (parenthesized) s = s.slice(1, -1);
  if (s.includes(",") && s.includes(".")) {
    s =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (s.includes(",")) s = s.replace(",", ".");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return parenthesized ? -n : n;
}

export function parseCents(value: unknown): Cents | null {
  const numeric = parseLocalizedNumber(value);
  if (numeric === null) return null;
  const scaled = numeric * 100;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) < 0.0001 ? makeCents(rounded) : null;
}
export function calendarDate(value: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? (value as CalendarDate)
    : null;
}
export const satispayTransactionId = (value: string): SatispayTransactionId | null =>
  value.trim() ? (value.trim() as SatispayTransactionId) : null;

/** Expected structural worksheet failures, separate from programming defects. */
export class WorksheetInputError extends Error {
  readonly _tag = "WorksheetInputError";
  readonly reason: "EmptyWorksheet" | "InsufficientColumns" | "MissingColumns" | "MissingIdColumn";
  constructor(reason: WorksheetInputError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
