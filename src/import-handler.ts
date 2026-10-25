import { observeOperation } from "./telemetry.ts";
import { Effect } from "effect";
import { AppConfig } from "./application/app-config.ts";
import { ImportFailedError, PreparedImportError } from "./errors.ts";
import { buildPreparedImport, PreparedImportInputError } from "./prepared-import.ts";
import { readSheetEffect } from "./spreadsheet.ts";
import { submitPreparedImportEffect } from "./ynab-service.ts";

export { PreparedImportError } from "./errors.ts";
type ImportMode = "prepare" | "import";

/** Import pipeline returns application outcomes; HTTP translation belongs to the router. */
export const processImportEffect = Effect.fn("satispay.import")(function* (
  mode: ImportMode,
  bytes: ArrayBuffer,
) {
  const config = yield* AppConfig;
  const fromDate = yield* config.importFrom;
  const rows = yield* readSheetEffect(bytes);
  const prepared = yield* Effect.try({
    try: () => buildPreparedImport(rows, fromDate),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      error instanceof PreparedImportInputError
        ? Effect.fail(new PreparedImportError({ reason: error.reason }))
        : Effect.die(error),
    ),
  );
  const summary = prepared.summary;
  if (mode === "prepare") return { _tag: "ImportPrepared" as const, summary };
  const result = yield* submitPreparedImportEffect(prepared).pipe(
    Effect.mapError((reason) => new ImportFailedError({ summary, reason })),
  );
  return { _tag: "ImportCompleted" as const, summary, result };
}, observeOperation("import"));
