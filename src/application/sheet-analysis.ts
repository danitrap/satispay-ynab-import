import type { Milliunits } from "../domain/primitives.ts";
import type { WalletBalanceCheck } from "../domain/movement-classification.ts";
import { Context, type Effect } from "effect";
import type { SheetCell, WorkbookError } from "./workbook-reader.ts";

export type SheetCategoryCounts = {
  readonly uniqueValues: number;
  readonly counts: readonly { readonly value: string; readonly count: number }[];
  readonly warning?: string;
};

export type SheetAmountStats = {
  readonly populated: number;
  readonly positive: number;
  readonly negative: number;
  readonly zero: number;
  readonly unparseable: number;
  readonly numberCells: number;
  readonly textCells: number;
};

/** Inspection summary of one decoded sheet. Column names stay in the export reader. */
export type SheetSummary = {
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly sheet: number;
  readonly analysis: {
    readonly types: SheetCategoryCounts | null;
    readonly statuses: SheetCategoryCounts | null;
    readonly identifiers: {
      readonly columnFound: boolean;
      readonly present: number;
      readonly missing: number;
      readonly distinct: number;
      readonly duplicateRows: number;
      readonly numericCells: number;
    };
    readonly dateCellTypes: {
      readonly date: number;
      readonly number: number;
      readonly text: number;
      readonly empty: number;
    };
    readonly monetaryColumns: Readonly<Record<string, SheetAmountStats>>;
  };
};

/** Dry-run summary of one movement classification. The HTTP presenter owns the response mode. */
export type PreviewSummary = {
  readonly rowCount: number;
  readonly eligible: number;
  readonly skipped: number;
  readonly requiresReview: number;
  readonly provisional: number;
  readonly outflowEur: string;
  readonly inflowEur: string;
  readonly netEur: string;
  readonly outflowMilliunits: Milliunits;
  readonly inflowMilliunits: Milliunits;
  readonly netMilliunits: Milliunits;
  readonly byType: Readonly<
    Record<string, { readonly include: number; readonly skip: number; readonly review: number }>
  >;
  readonly byReason: Readonly<Record<string, number>>;
  readonly refundsAdjusted: number;
  readonly refundsUnresolved: number;
  readonly balanceCheck: WalletBalanceCheck;
  readonly imported: number;
  readonly message: string;
};

/**
 * Port for row inspection and the dry-run summary.
 * The export reader owns column names; preview and inspect reach them through this port.
 */
export class SheetAnalysis extends Context.Service<
  SheetAnalysis,
  {
    readonly preview: (
      rows: readonly (readonly SheetCell[])[],
    ) => Effect.Effect<PreviewSummary, WorkbookError>;
    readonly summarize: (
      rows: readonly (readonly SheetCell[])[],
    ) => Effect.Effect<SheetSummary, WorkbookError>;
  }
>()("satispay/SheetAnalysis") {}
