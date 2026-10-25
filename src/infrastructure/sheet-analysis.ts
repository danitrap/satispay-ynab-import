import { PreparedImportInputError } from "../application/prepared-import-input.ts";
import { SheetAnalysis } from "../application/sheet-analysis.ts";
import { WorkbookError } from "../application/workbook-reader.ts";
import { Effect, Layer } from "effect";
import { previewSatispay } from "./preview-rows.ts";
import { summarizeSheet } from "./satispay-export-reader.ts";
import { WorksheetInputError } from "./worksheet-input.ts";

/** Normalize only declared input errors; preserve the identity of unexpected defects. */
const analysisFailure = (error: unknown) =>
  error instanceof WorksheetInputError || error instanceof PreparedImportInputError
    ? Effect.fail(new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file."))
    : Effect.die(error);

const fromRows = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) => error,
  }).pipe(Effect.catch(analysisFailure));

export const sheetAnalysisLayer = Layer.succeed(SheetAnalysis, {
  preview: (rows) => fromRows(() => previewSatispay(rows)),
  summarize: (rows) => fromRows(() => summarizeSheet(rows)),
});
