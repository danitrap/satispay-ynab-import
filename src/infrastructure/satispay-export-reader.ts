import {
  SatispayExportHeaderError,
  SatispayExportReader,
  type SatispayExportHeaderReason,
} from "../application/satispay-export-reader.ts";
import { calendarDate, parseCents } from "../domain.ts";
import type {
  MovementAmount,
  SatispayApproval,
  SatispayExportRead,
  SatispayMovement,
  SatispayMovementDate,
  SatispayMovementIdentifier,
  SatispayMovementKind,
} from "../domain/satispay-movement.ts";
import type { SheetCell } from "../spreadsheet.ts";
import { WorkbookReader } from "../workbook-reader.ts";
import { Effect, Layer } from "effect";

/**
 * Italian column names and status labels stay in this module.
 * The row-based preview and prepared-import path does not call this reader yet.
 */

const COLUMN = {
  date: "Data",
  name: "Nome",
  description: "Descrizione",
  nominalAmount: "Importo",
  type: "Tipo",
  status: "Stato",
  reportedWalletAmount: "Disponibilità",
  mealVoucher: "Buoni Pasto",
  flexBenefit: "FlexBen",
  walletBalance: "Disponibilità dopo la transazione",
} as const;

const REQUIRED_COLUMNS = [
  COLUMN.date,
  COLUMN.name,
  COLUMN.description,
  COLUMN.nominalAmount,
  COLUMN.type,
  COLUMN.status,
  COLUMN.reportedWalletAmount,
] as const;

const APPROVED_STATUS = "✅ Approvato";
const MERCHANT_PURCHASE = "🏬 a un Negozio";
const MERCHANT_REFUND = "🔄 Rimborso";
const CASHBACK = "🎖️ Punti";
const EMPTY_NAME = "-";

const text = (value: SheetCell): string =>
  value === null || value === undefined ? "" : String(value).trim();

const blank = (value: SheetCell): boolean => text(value) === "";

const amount = (value: SheetCell): MovementAmount => {
  if (blank(value)) return { _tag: "Absent" };
  const cents = parseCents(value);
  return cents === null ? { _tag: "Unreadable" } : { _tag: "Amount", cents };
};

const movementDate = (value: SheetCell): SatispayMovementDate => {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return { _tag: "Invalid" };
    const parsed = calendarDate(value.toISOString().slice(0, 10));
    return parsed === null
      ? { _tag: "Invalid" }
      : { _tag: "Valid", calendarDate: parsed, instantMs: value.valueOf() };
  }
  const parsed = calendarDate(text(value));
  if (parsed === null) return { _tag: "Invalid" };
  return {
    _tag: "Valid",
    calendarDate: parsed,
    instantMs: Date.parse(`${parsed}T00:00:00.000Z`),
  };
};

const movementKind = (typeLabel: string): SatispayMovementKind => {
  if (typeLabel === MERCHANT_PURCHASE) return "merchantPurchase";
  if (typeLabel === MERCHANT_REFUND) return "merchantRefund";
  if (typeLabel === CASHBACK) return "cashback";
  return "other";
};

const satispayApproval = (value: SheetCell): SatispayApproval =>
  text(value) === APPROVED_STATUS ? "approved" : "notApproved";

const movementName = (value: SheetCell): string => {
  const name = text(value);
  return name === EMPTY_NAME ? "" : name;
};

const isMovementIdentifierColumn = (name: string): boolean =>
  name === "ID" || name.startsWith("ID (");

type ParsedExport =
  | { readonly _tag: "Export"; readonly satispayExport: SatispayExportRead }
  | { readonly _tag: "HeaderError"; readonly reason: SatispayExportHeaderReason };

const headerError = (
  reason: SatispayExportHeaderReason,
): Extract<ParsedExport, { _tag: "HeaderError" }> => ({ _tag: "HeaderError", reason });

/** Empty rows carry no movement. The first remaining row is the header. */
function parseSatispayExport(rows: readonly (readonly SheetCell[])[]): ParsedExport {
  const nonEmpty = rows.filter((row) => row.some((cell) => !blank(cell)));
  if (nonEmpty.length === 0) return headerError("EmptyExport");
  const [headerRow, ...body] = nonEmpty;
  const header = headerRow.map(text);
  const column = (name: string) => header.indexOf(name);
  if (REQUIRED_COLUMNS.some((name) => column(name) < 0)) return headerError("MissingColumns");
  const identifierAt = header.findIndex(isMovementIdentifierColumn);
  if (identifierAt < 0) return headerError("MissingMovementIdentifier");

  const cell = (row: readonly SheetCell[], index: number): SheetCell =>
    index < 0 ? null : row[index];
  const counts = new Map<string, number>();
  const identifierText = (row: readonly SheetCell[]): string | null => {
    const value = cell(row, identifierAt);
    if (blank(value) || typeof value !== "string") return null;
    return text(value);
  };
  for (const row of body) {
    const value = identifierText(row);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const identifierOf = (row: readonly SheetCell[]): SatispayMovementIdentifier => {
    const value = cell(row, identifierAt);
    if (blank(value)) return { _tag: "Missing" };
    if (typeof value !== "string") return { _tag: "NotText" };
    const trimmed = text(value);
    return (counts.get(trimmed) ?? 0) === 1
      ? { _tag: "Unique", value: trimmed }
      : { _tag: "Duplicate", value: trimmed };
  };

  const mealAt = column(COLUMN.mealVoucher);
  const flexAt = column(COLUMN.flexBenefit);
  const balanceAt = column(COLUMN.walletBalance);
  const movements: SatispayMovement[] = body.map((row) => {
    const typeLabel = text(cell(row, column(COLUMN.type)));
    return {
      satispayMovementIdentifier: identifierOf(row),
      date: movementDate(cell(row, column(COLUMN.date))),
      nominalAmount: amount(cell(row, column(COLUMN.nominalAmount))),
      reportedWalletAmount: amount(cell(row, column(COLUMN.reportedWalletAmount))),
      mealVoucherAmount: amount(cell(row, mealAt)),
      flexBenefitAmount: amount(cell(row, flexAt)),
      walletBalance: amount(cell(row, balanceAt)),
      satispayApproval: satispayApproval(cell(row, column(COLUMN.status))),
      kind: movementKind(typeLabel),
      typeLabel,
      name: movementName(cell(row, column(COLUMN.name))),
      description: text(cell(row, column(COLUMN.description))),
    };
  });
  return {
    _tag: "Export",
    satispayExport: { movements, includesWalletBalance: balanceAt >= 0 },
  };
}

export const satispayExportReaderLayer = Layer.effect(
  SatispayExportReader,
  Effect.gen(function* () {
    const workbook = yield* WorkbookReader;
    return {
      read: (file) =>
        workbook.read(file).pipe(
          Effect.flatMap((rows) => {
            const parsed = parseSatispayExport(rows);
            return parsed._tag === "HeaderError"
              ? Effect.fail(new SatispayExportHeaderError({ reason: parsed.reason }))
              : Effect.succeed(parsed.satispayExport);
          }),
        ),
    };
  }),
);
