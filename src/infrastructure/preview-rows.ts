import { PreparedImportInputError } from "../application/prepared-import-input.ts";
import { previewSummary } from "../application/preview.ts";
import { classifyMovements } from "../domain/movement-classification.ts";
import type { SheetCell } from "../application/workbook-reader.ts";
import { parseSatispayExport } from "./satispay-export-reader.ts";
import { WorksheetInputError } from "./worksheet-input.ts";

const headerError = (reason: "EmptyExport" | "MissingColumns" | "MissingMovementIdentifier") => {
  switch (reason) {
    case "EmptyExport":
      return new WorksheetInputError("EmptyWorksheet");
    case "MissingColumns":
      return new WorksheetInputError("MissingColumns");
    case "MissingMovementIdentifier":
      return new WorksheetInputError("MissingIdColumn");
  }
};

/** Preview classifies the whole export and does not apply an import cutoff. */
export function previewSatispay(rows: readonly (readonly SheetCell[])[]) {
  const parsed = parseSatispayExport(rows);
  if (parsed._tag === "HeaderError") throw headerError(parsed.reason);
  return previewSummary(classifyMovements(parsed.satispayExport));
}
