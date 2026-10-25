import { SheetAnalysis } from "./sheet-analysis.ts";
import { readSheetEffect } from "./workbook-reader.ts";
import { Effect } from "effect";

/** Inspect one workbook. The summary reports columns, not individual movements. */
export const inspectXlsxEffect = (file: ArrayBuffer) =>
  readSheetEffect(file).pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        const analysis = yield* SheetAnalysis;
        return yield* analysis.summarize(rows);
      }),
    ),
  );
