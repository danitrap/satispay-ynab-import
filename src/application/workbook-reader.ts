import { observeOperation } from "./telemetry.ts";
import { Context, Data, Effect } from "effect";

/** A cell from a decoded Satispay export. */
export type SheetCell = string | number | boolean | Date | null | undefined;

/** The workbook decoder could not read the upload. Created at the workbook boundary. */
export class WorkbookError extends Data.TaggedError("WorkbookError")<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

/** The external XLSX decoder is the only replaceable part of workbook decoding. */
export class WorkbookReader extends Context.Service<
  WorkbookReader,
  {
    readonly read: (file: ArrayBuffer) => Effect.Effect<SheetCell[][], WorkbookError>;
  }
>()("satispay/WorkbookReader") {}

/** Untrusted xlsx decoding happens at the I/O boundary, errors remain typed. */
export const readSheetEffect = Effect.fn("satispay.workbook")(function* (file: ArrayBuffer) {
  const reader = yield* WorkbookReader;
  return yield* reader.read(file);
}, observeOperation("workbook"));
