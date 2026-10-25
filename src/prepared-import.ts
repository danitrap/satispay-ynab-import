import type { SatispayExportHeaderReason } from "./application/satispay-export-reader.ts";
import {
  summarizePreparedImport,
  type PreparedImportSummary,
} from "./application/prepare-import.ts";
import {
  calendarDate,
  satispayTransactionId,
  type CalendarDate,
  type Milliunits,
  type SatispayTransactionId,
} from "./domain.ts";
import { reviewMemo } from "./application/ynab-transaction.ts";
import type { AmbiguityReason, WalletBalanceCheck } from "./domain/movement-classification.ts";
import { prepareImport, type PreparedImport } from "./domain/prepared-import.ts";
import type { SatispayMovement } from "./domain/satispay-movement.ts";
import { parseSatispayExport } from "./infrastructure/satispay-export-reader.ts";
import type { SheetCell } from "./spreadsheet.ts";

export type { PreparedImportSummary };

/**
 * Turns one Satispay export into a prepared import and the YNAB candidates selected from it.
 * Eligibility comes only from movement classification. Column names stay in the export reader.
 */

export type PreparedImportInputReason =
  "InvalidCutoff" | "EmptyWorkbook" | "MissingColumns" | "MissingIdColumn" | "AmountOverflow";

export class PreparedImportInputError extends Error {
  readonly _tag = "PreparedImportInputError";
  readonly reason: PreparedImportInputReason;
  constructor(reason: PreparedImportInputReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Fields the current YNAB submission still needs from each selected movement. */
export type YnabImportCandidate = {
  readonly satispayId: SatispayTransactionId;
  readonly date: CalendarDate;
  readonly amountMilliunits: Milliunits;
  readonly payee: string;
  readonly memo: string;
  readonly type: string;
  readonly reviewReason?: AmbiguityReason;
};

export type BuiltPreparedImport = {
  readonly preparedImport: PreparedImport;
  readonly candidates: YnabImportCandidate[];
  readonly counts: {
    readonly exported: number;
    readonly olderThanStart: number;
    readonly withoutAvailability: number;
    readonly rejected: number;
    readonly provisional: number;
    readonly inScope: number;
  };
  readonly issues: Readonly<Record<string, number>>;
  readonly reviewIssues: Readonly<Record<string, number>>;
  readonly fromDate: CalendarDate;
  readonly inflowMilliunits: Milliunits;
  readonly outflowMilliunits: Milliunits;
  readonly netMilliunits: Milliunits;
  readonly refundsAdjusted: number;
  readonly refundsUnresolved: number;
  readonly balanceCheck: WalletBalanceCheck;
  readonly summary: PreparedImportSummary;
};

const inputReason = (reason: SatispayExportHeaderReason): PreparedImportInputReason => {
  switch (reason) {
    case "EmptyExport":
      return "EmptyWorkbook";
    case "MissingColumns":
      return "MissingColumns";
    case "MissingMovementIdentifier":
      return "MissingIdColumn";
  }
};

const clip = (value: string, fallback: string, maximum: number): string =>
  (value || fallback).slice(0, maximum);

function candidateFrom(
  movement: SatispayMovement,
  amountMilliunits: Milliunits,
  reviewReason?: AmbiguityReason,
): YnabImportCandidate {
  const identifier = movement.satispayMovementIdentifier;
  if (identifier._tag !== "Unique" || movement.date._tag !== "Valid") {
    throw new Error("A selected movement is missing its identifier or date");
  }
  const satispayId = satispayTransactionId(identifier.value);
  if (satispayId === null) throw new Error("A selected movement is missing its identifier or date");
  const fallbackPayee = movement.typeLabel ? "Satispay — " + movement.typeLabel : "Satispay";
  const named = movement.name || fallbackPayee;
  return {
    satispayId,
    date: movement.date.calendarDate,
    amountMilliunits,
    payee:
      amountMilliunits > 0 && movement.kind === "cashback"
        ? "Satispay Cashback"
        : clip(named, "Satispay", 80),
    memo: reviewReason
      ? reviewMemo(reviewReason, movement.description)
      : clip(movement.description, "", 200),
    type: movement.typeLabel,
    ...(reviewReason ? { reviewReason } : {}),
  };
}

/** `/prepare` and `/import` both start here. The import cutoff is the only difference from preview. */
export function buildPreparedImport(
  rows: readonly (readonly SheetCell[])[],
  fromDate: string,
): BuiltPreparedImport {
  const importCutoff = calendarDate(fromDate);
  if (!importCutoff) throw new PreparedImportInputError("InvalidCutoff");
  const parsed = parseSatispayExport(rows);
  if (parsed._tag === "HeaderError") throw new PreparedImportInputError(inputReason(parsed.reason));
  const preparedImport = prepareImport(parsed.satispayExport, importCutoff);
  const totals = preparedImport.totals;
  if (totals._tag === "Overflow") throw new PreparedImportInputError("AmountOverflow");
  const summary = summarizePreparedImport(preparedImport, totals);
  const candidates: YnabImportCandidate[] = [];
  for (const classified of preparedImport.movements) {
    switch (classified._tag) {
      case "ProvisionalTransaction":
        candidates.push(
          candidateFrom(classified.movement, classified.amountMilliunits, classified.reason),
        );
        break;
      case "ImportCandidate":
        candidates.push(candidateFrom(classified.movement, classified.amountMilliunits));
        break;
      case "SkippedMovement":
      case "RejectedMovement":
        break;
    }
  }
  candidates.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.satispayId.localeCompare(right.satispayId),
  );
  return {
    preparedImport,
    candidates,
    counts: {
      exported: summary.exported,
      olderThanStart: summary.olderThanStart,
      withoutAvailability: summary.withoutAvailability,
      rejected: summary.rejected,
      provisional: summary.provisional,
      inScope: summary.inScope,
    },
    issues: summary.issues,
    reviewIssues: summary.reviewIssues,
    fromDate: summary.fromDate,
    inflowMilliunits: summary.inflowMilliunits,
    outflowMilliunits: summary.outflowMilliunits,
    netMilliunits: summary.netMilliunits,
    refundsAdjusted: summary.refundsAdjusted,
    refundsUnresolved: summary.refundsUnresolved,
    balanceCheck: summary.balanceCheck,
    summary,
  };
}
