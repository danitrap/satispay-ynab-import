import { AppConfig, type ConfigurationError } from "./app-config.ts";
import { SatispayExportReader, type SatispayExportHeaderReason } from "./satispay-export-reader.ts";
import type { CalendarDate, Milliunits } from "../domain/primitives.ts";
import type { WalletBalanceCheck } from "../domain/movement-classification.ts";
import {
  prepareImport as prepareDomainImport,
  type PreparedImport,
} from "../domain/prepared-import.ts";
import { Data, Effect } from "effect";

/**
 * Prepares one Satispay export for an import cutoff.
 * Preview classifies the same export without the cutoff. This use case applies it.
 */

export type PreparedImportInputReason =
  "InvalidCutoff" | "EmptyWorkbook" | "MissingColumns" | "MissingIdColumn" | "AmountOverflow";

export class PreparedImportError extends Data.TaggedError("PreparedImportError")<{
  readonly reason: PreparedImportInputReason;
}> {
  override get message(): string {
    return {
      InvalidCutoff: "Invalid YNAB_IMPORT_FROM: expected YYYY-MM-DD",
      EmptyWorkbook: "Empty Satispay spreadsheet",
      MissingColumns: "Missing Satispay export columns",
      MissingIdColumn: "Missing Satispay transaction ID column",
      AmountOverflow: "Wallet totals exceed the safe integer range",
    }[this.reason];
  }
}

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

export type PrepareImportFailure = ConfigurationError | PreparedImportError;

const headerReason = (reason: SatispayExportHeaderReason): PreparedImportInputReason => {
  switch (reason) {
    case "EmptyExport":
      return "EmptyWorkbook";
    case "MissingColumns":
      return "MissingColumns";
    case "MissingMovementIdentifier":
      return "MissingIdColumn";
  }
};

/** Counts for one prepared import. The caller passes totals only after refusing overflow. */
export function summarizePreparedImport(
  prepared: PreparedImport,
  totals: Extract<PreparedImport["totals"], { _tag: "Exact" }>,
): PreparedImportSummary {
  const issues: Record<string, number> = {};
  const reviewIssues: Record<string, number> = {};
  let olderThanStart = 0;
  let withoutAvailability = 0;
  let rejected = 0;
  let provisional = 0;
  let inScope = 0;
  for (const classified of prepared.movements) {
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
        inScope++;
        reviewIssues[classified.reason] = (reviewIssues[classified.reason] ?? 0) + 1;
        break;
      case "ImportCandidate":
        inScope++;
        break;
    }
  }
  return {
    exported: prepared.movements.length,
    olderThanStart,
    withoutAvailability,
    rejected,
    provisional,
    inScope,
    issues,
    reviewIssues,
    requiresReview: rejected + provisional,
    fromDate: prepared.importCutoff,
    inflowMilliunits: totals.inflowMilliunits,
    outflowMilliunits: totals.outflowMilliunits,
    netMilliunits: totals.netMilliunits,
    refundsAdjusted: prepared.refundsAdjusted,
    refundsUnresolved: prepared.refundsUnresolved,
    balanceCheck: prepared.balanceCheck,
    eligible: inScope,
  };
}

/** Read one export and apply the import cutoff. The result is what `/prepare` and `/import` share. */
export const prepareImportFromFile = Effect.fn("satispay.prepareImport")(function* (
  file: ArrayBuffer,
) {
  const config = yield* AppConfig;
  const reader = yield* SatispayExportReader;
  const importCutoff = yield* config.importFrom;
  const satispayExport = yield* reader
    .read(file)
    .pipe(
      Effect.mapError((error) =>
        error._tag === "SatispayExportHeaderError"
          ? new PreparedImportError({ reason: headerReason(error.reason) })
          : error,
      ),
    );
  const preparedImport = prepareDomainImport(satispayExport, importCutoff);
  const totals = preparedImport.totals;
  if (totals._tag === "Overflow")
    return yield* new PreparedImportError({ reason: "AmountOverflow" });
  return { preparedImport, summary: summarizePreparedImport(preparedImport, totals) };
});
