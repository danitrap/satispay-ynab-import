import type { CalendarDate } from "../domain.ts";
import { classifyMovements, type MovementClassification } from "./movement-classification.ts";
import type { SatispayExportRead } from "./satispay-movement.ts";

/**
 * A prepared import is the shared movement classification for one import cutoff.
 * Preview classifies the same export without a cutoff. Nothing here throws or imports Effect.
 */
export type PreparedImport = MovementClassification & {
  readonly importCutoff: CalendarDate;
};

export function prepareImport(
  satispayExport: SatispayExportRead,
  importCutoff: CalendarDate,
): PreparedImport {
  return { ...classifyMovements(satispayExport, importCutoff), importCutoff };
}
