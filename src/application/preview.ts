import { PreparedImportInputError } from "./prepared-import-input.ts";
import { SheetAnalysis, type PreviewSummary } from "./sheet-analysis.ts";
import { readSheetEffect } from "./workbook-reader.ts";
import type { Milliunits } from "../domain/primitives.ts";
import {
  classifyMovements,
  type ClassifiedMovement,
  type MovementClassification,
} from "../domain/movement-classification.ts";
import { Effect } from "effect";

type PreviewRow = {
  decision: "include" | "skip" | "review";
  reason: string;
  type: string;
  amountMilliunits?: Milliunits;
  provisional?: boolean;
};

function presentRow(classified: ClassifiedMovement): PreviewRow {
  const type = classified.movement.typeLabel || "(vuoto)";
  switch (classified._tag) {
    case "SkippedMovement":
      return { decision: "skip", reason: classified.reason, type };
    case "RejectedMovement":
      return { decision: "review", reason: classified.reason, type };
    case "ProvisionalTransaction":
      return {
        decision: "include",
        reason: classified.reason,
        type,
        amountMilliunits: classified.amountMilliunits,
        provisional: true,
      };
    case "ImportCandidate":
      return {
        decision: "include",
        reason: classified.walletAmount < 0 ? "wallet_outflow" : "wallet_inflow",
        type,
        amountMilliunits: classified.amountMilliunits,
      };
  }
}

/**
 * Whole-export preview. The domain classifies movements; this shapes the dry-run summary.
 * The HTTP presenter owns the response mode.
 */
export function previewSummary(classification: MovementClassification): PreviewSummary {
  if (classification.totals._tag === "Overflow")
    throw new PreparedImportInputError("AmountOverflow");
  const totals = classification.totals;
  const all = classification.movements.map(presentRow);
  const byType = new Map<string, { include: number; skip: number; review: number }>();
  const byReason = new Map<string, number>();
  for (const result of all) {
    const bucket = byType.get(result.type) ?? { include: 0, skip: 0, review: 0 };
    bucket[result.decision]++;
    if (result.provisional) bucket.review++;
    byType.set(result.type, bucket);
    byReason.set(result.reason, (byReason.get(result.reason) ?? 0) + 1);
  }
  const count = (decision: PreviewRow["decision"]) =>
    all.filter((row) => row.decision === decision).length;
  // Keep arithmetic in integer cents and serialize display amounts as strings.
  // This prevents Apple Shortcuts from showing binary floating-point artifacts.
  const money = (cents: number): string => {
    const abs = Math.abs(cents);
    return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  };
  const inflowCents = totals.inflowMilliunits / 10;
  const outflowCents = totals.outflowMilliunits / 10;
  return {
    rowCount: all.length,
    eligible: count("include"),
    skipped: count("skip"),
    requiresReview: count("review") + all.filter((row) => row.provisional).length,
    provisional: all.filter((row) => row.provisional).length,
    outflowEur: money(outflowCents),
    inflowEur: money(inflowCents),
    netEur: money(inflowCents - outflowCents),
    outflowMilliunits: totals.outflowMilliunits,
    inflowMilliunits: totals.inflowMilliunits,
    netMilliunits: totals.netMilliunits,
    byType: Object.fromEntries([...byType.entries()]),
    byReason: Object.fromEntries([...byReason.entries()]),
    refundsAdjusted: classification.refundsAdjusted,
    refundsUnresolved: classification.refundsUnresolved,
    balanceCheck: classification.balanceCheck,
    imported: 0,
    message:
      "Dry run only. No transactions sent to YNAB. Transfers can be adjusted manually in YNAB.",
  };
}

/** Preview classifies the whole export and does not apply an import cutoff. */
export const previewXlsxEffect = (file: ArrayBuffer) =>
  readSheetEffect(file).pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        const analysis = yield* SheetAnalysis;
        return yield* analysis.preview(rows);
      }),
    ),
  );
