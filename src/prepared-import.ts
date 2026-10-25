import type { SatispayExportHeaderReason } from "./application/satispay-export-reader.ts";
import {
  calendarDate,
  satispayTransactionId,
  type CalendarDate,
  type Milliunits,
  type SatispayTransactionId,
} from "./domain.ts";
import type { AmbiguityReason, WalletBalanceCheck } from "./domain/movement-classification.ts";
import { prepareImport, type PreparedImport } from "./domain/prepared-import.ts";
import type { SatispayMovement } from "./domain/satispay-movement.ts";
import { parseSatispayExport } from "./infrastructure/satispay-export-reader.ts";
import type { SheetCell } from "./spreadsheet.ts";

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

export type PreparedImportSummary = {
  readonly exported: number;
  readonly olderThanStart: number;
  readonly withoutAvailability: number;
  readonly rejected: number;
  readonly provisional: number;
  readonly inScope: number;
  readonly issues: Readonly<Record<string, number>>;
  readonly reviewIssues: Readonly<Record<string, number>>;
  readonly requiresReview: number;
  readonly fromDate: CalendarDate;
  readonly inflowMilliunits: Milliunits;
  readonly outflowMilliunits: Milliunits;
  readonly netMilliunits: Milliunits;
  readonly refundsAdjusted: number;
  readonly refundsUnresolved: number;
  readonly balanceCheck: WalletBalanceCheck;
  readonly eligible: number;
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

/** ADR 0001 review memo. The wording stays stable so transaction review instructions do not drift. */
function reviewMemo(reason: AmbiguityReason, description: string): string {
  const explanation = {
    ambiguous_refund_purchase: "Multiple original purchases match this refund.",
    refund_purchase_not_in_export: "The original purchase is absent from this export.",
    refund_purchase_funding_mismatch:
      "The original purchase has inconsistent wallet/benefit funding.",
    invalid_refund_details: "The refund details cannot be verified.",
    refund_exceeds_remaining_amount:
      "The refund exceeds the remaining wallet amount of the original purchase.",
    partial_refund_split_unknown:
      "The cash and benefit split of this partial refund cannot be determined.",
  }[reason];
  const instruction = `[Satispay review] ${explanation} Using reported Disponibilità as the provisional wallet amount. Verify the cash/benefit split, correct the amount, then clear, approve and remove the orange flag.`;
  return (instruction + (description ? "\n" + description : "")).slice(0, 500);
}

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
  if (preparedImport.totals._tag === "Overflow")
    throw new PreparedImportInputError("AmountOverflow");
  const totals = preparedImport.totals;
  const candidates: YnabImportCandidate[] = [];
  const issues: Record<string, number> = {};
  const reviewIssues: Record<string, number> = {};
  let olderThanStart = 0;
  let withoutAvailability = 0;
  let rejected = 0;
  let provisional = 0;
  for (const classified of preparedImport.movements) {
    switch (classified._tag) {
      case "SkippedMovement":
        if (classified.reason === "outside_import_period") olderThanStart++;
        else withoutAvailability++;
        break;
      case "RejectedMovement":
        rejected++;
        issues[classified.reason] = (issues[classified.reason] ?? 0) + 1;
        break;
      case "ProvisionalTransaction":
        provisional++;
        reviewIssues[classified.reason] = (reviewIssues[classified.reason] ?? 0) + 1;
        candidates.push(
          candidateFrom(classified.movement, classified.amountMilliunits, classified.reason),
        );
        break;
      case "ImportCandidate":
        candidates.push(candidateFrom(classified.movement, classified.amountMilliunits));
        break;
    }
  }
  candidates.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.satispayId.localeCompare(right.satispayId),
  );
  const counts = {
    exported: preparedImport.movements.length,
    olderThanStart,
    withoutAvailability,
    rejected,
    provisional,
    inScope: candidates.length,
  };
  const summary: PreparedImportSummary = {
    ...counts,
    issues,
    reviewIssues,
    requiresReview: rejected + provisional,
    fromDate: importCutoff,
    inflowMilliunits: totals.inflowMilliunits,
    outflowMilliunits: totals.outflowMilliunits,
    netMilliunits: totals.netMilliunits,
    refundsAdjusted: preparedImport.refundsAdjusted,
    refundsUnresolved: preparedImport.refundsUnresolved,
    balanceCheck: preparedImport.balanceCheck,
    eligible: candidates.length,
  };
  return {
    preparedImport,
    candidates,
    counts,
    issues,
    reviewIssues,
    fromDate: importCutoff,
    inflowMilliunits: totals.inflowMilliunits,
    outflowMilliunits: totals.outflowMilliunits,
    netMilliunits: totals.netMilliunits,
    refundsAdjusted: preparedImport.refundsAdjusted,
    refundsUnresolved: preparedImport.refundsUnresolved,
    balanceCheck: preparedImport.balanceCheck,
    summary,
  };
}
