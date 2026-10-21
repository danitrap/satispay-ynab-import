import { Duration, Effect, Exit, Metric } from "effect";

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
