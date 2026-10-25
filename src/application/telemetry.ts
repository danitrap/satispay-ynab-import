import { Duration, Effect, Exit, Logger, Metric } from "effect";

/** Keep operation fields searchable while giving Workers Logs a readable message. */
export const operationLogger = Logger.withConsoleLog(
  Logger.map(Logger.formatStructured, (log) => {
    const entry = log.message;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("event" in entry) ||
      entry.event !== "satispay.operation" ||
      !("operation" in entry) ||
      typeof entry.operation !== "string" ||
      !("outcome" in entry) ||
      (entry.outcome !== "success" && entry.outcome !== "failure") ||
      !("durationMs" in entry) ||
      typeof entry.durationMs !== "number"
    ) {
      return log;
    }
    return {
      ...log,
      message: `${entry.operation} ${entry.outcome === "success" ? "completed" : "failed"}`,
      event: entry.event,
      operation: entry.operation,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
    };
  }),
);

type Operation = "upload" | "workbook" | "import" | "ynab.read" | "ynab.write";
export const operationDuration = Metric.histogram("satispay_operation_duration_ms", {
  boundaries: [1, 10, 50, 100, 500, 1000, 5000, 10000, 30000],
});
export const operationCount = Metric.counter("satispay_operations_total", { incremental: true });

/** Only bounded operation/outcome labels; never record arguments or failure payloads. */
export const observeOperation =
  (operation: Operation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.clockWith((clock) => {
      const start = clock.monotonicTimeNanosUnsafe();
      return effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const durationMs = Duration.toMillis(
              Duration.nanos(clock.monotonicTimeNanosUnsafe() - start),
            );
            const outcome = Exit.isSuccess(exit) ? "success" : "failure";
            yield* Metric.update(
              Metric.withAttributes(operationDuration, { operation }),
              durationMs,
            );
            yield* Metric.update(Metric.withAttributes(operationCount, { operation, outcome }), 1);
            yield* Effect.logInfo({
              event: "satispay.operation",
              operation,
              outcome,
              durationMs,
            });
          }),
        ),
      );
    });
