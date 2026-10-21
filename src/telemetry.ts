import { Clock, Effect, Exit, Metric } from "effect";

type Operation = "upload" | "workbook" | "import" | "ynab.read" | "ynab.write";
export const operationDuration = Metric.histogram("satispay_operation_duration_ms", {
  boundaries: [1, 10, 50, 100, 500, 1000, 5000, 10000, 30000],
});
export const operationCount = Metric.counter("satispay_operations_total", { incremental: true });

/** Only bounded operation/outcome labels; never record arguments or failure payloads. */
export const observeOperation =
  (operation: Operation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeNanos;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const ended = yield* Clock.currentTimeNanos;
            yield* Metric.update(
              Metric.withAttributes(operationDuration, { operation }),
              Number(ended - started) / 1_000_000,
            );
            yield* Metric.update(
              Metric.withAttributes(operationCount, {
                operation,
                outcome: Exit.isSuccess(exit) ? "success" : "failure",
              }),
              1,
            );
          }),
        ),
      );
    });
