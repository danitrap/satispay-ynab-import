import { WorkbookError, WorkbookReader, type SheetCell } from "../application/workbook-reader.ts";
import { Effect, Layer } from "effect";

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
