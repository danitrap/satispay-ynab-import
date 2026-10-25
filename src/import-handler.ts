import { observeOperation } from "./telemetry.ts";
import { PlanInputError } from "./domain.ts";
import { Effect } from "effect";
import { AppConfig } from "./application/app-config.ts";
import { buildImportPlan, summarizeImportPlan } from "./import-plan.ts";
import { ImportFailedError, ImportPlanError } from "./errors.ts";
import { readSheetEffect } from "./spreadsheet.ts";
import { importPlanEffect } from "./ynab-service.ts";

export { ImportPlanError } from "./errors.ts";
type ImportMode = "prepare" | "import";

/** Import pipeline returns application outcomes; HTTP translation belongs to the router. */
export const processImportEffect = Effect.fn("satispay.import")(function* (
  mode: ImportMode,
  bytes: ArrayBuffer,
) {
  const config = yield* AppConfig;
  const fromDate = yield* config.importFrom;
  const rows = yield* readSheetEffect(bytes);
  const plan = yield* Effect.try({
    try: () => buildImportPlan(rows, fromDate),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      error instanceof PlanInputError
        ? Effect.fail(new ImportPlanError({ reason: error.reason }))
        : Effect.die(error),
    ),
  );
  const summary = summarizeImportPlan(plan);
  if (mode === "prepare") return { _tag: "ImportPrepared" as const, summary };
  const result = yield* importPlanEffect(plan).pipe(
    Effect.mapError((reason) => new ImportFailedError({ summary, reason })),
  );
  return { _tag: "ImportCompleted" as const, summary, result };
}, observeOperation("import"));
