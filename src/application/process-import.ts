import { importPrepared, type ImportFailure } from "./import-prepared.ts";
import { prepareImportFromFile, type PreparedImportSummary } from "./prepare-import.ts";
import { observeOperation } from "./telemetry.ts";
import { Data, Effect } from "effect";

type ImportMode = "prepare" | "import";

/** Attaches the prepared-import summary to an import failure so the response can show both. */
export class ImportFailedError extends Data.TaggedError("ImportFailedError")<{
  readonly summary: PreparedImportSummary;
  readonly reason: ImportFailure;
}> {
  override get message(): string {
    return this.reason.message;
  }
}

/** `/prepare` and `/import` share one prepared import. Only import submits it. */
export const processImportEffect = Effect.fn("satispay.import")(function* (
  mode: ImportMode,
  bytes: ArrayBuffer,
) {
  const prepared = yield* prepareImportFromFile(bytes);
  if (mode === "prepare") return { _tag: "ImportPrepared" as const, summary: prepared.summary };
  const outcome = yield* importPrepared(prepared.preparedImport).pipe(
    Effect.mapError((reason) => new ImportFailedError({ summary: prepared.summary, reason })),
  );
  return { _tag: "ImportCompleted" as const, summary: prepared.summary, outcome };
}, observeOperation("import"));
