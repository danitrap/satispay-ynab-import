import { Context, Effect, Layer } from "effect";
import { WorkbookError } from "./errors.ts";
import type { SheetCell } from "./spreadsheet.ts";

/** The external XLSX decoder is the only replaceable part of workbook analysis. */
export class WorkbookReader extends Context.Service<
  WorkbookReader,
  {
    readonly read: (file: ArrayBuffer) => Effect.Effect<SheetCell[][], WorkbookError>;
  }
>()("satispay/WorkbookReader") {}

export const workbookReaderLayer = Layer.succeed(WorkbookReader, {
  read: (file) =>
    Effect.tryPromise({
      try: async () => {
        const { readSheet } = await import("read-excel-file/universal");
        // The dependency types Date cells as typeof Date; actual cells are Date instances.
        return (await readSheet(file)) as unknown as SheetCell[][];
      },
      catch: () => new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file."),
    }),
});
