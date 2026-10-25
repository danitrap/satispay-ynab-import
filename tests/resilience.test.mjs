import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Clock, Effect, Fiber, Logger, Metric } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { findAccountsEffect, importPlanEffect, requestLiveLayer } from "../src/ynab-service.ts";
import worker, { handleRequestEffect } from "../src/index.ts";
import {
  operationCount,
  operationDuration,
  observeOperation,
  operationLogger,
} from "../src/telemetry.ts";

const env = {
  UPLOAD_TOKEN: "upload",
  YNAB_TOKEN: "fake",
  YNAB_PLAN_ID: "plan",
  YNAB_ACCOUNT_ID: "wallet",
  YNAB_WRITE_ENABLED: "true",
};
const account = { id: "wallet", name: "Satispay", on_budget: true, closed: false };
const plan = {
  counts: { rejected: 0 },
  candidates: [
    {
      satispayId: "test",
      date: "2026-10-18",
      amountMilliunits: -1000,
      payee: "Shop",
      memo: "",
      type: "Altro",
    },
  ],
};
const clocked = (program) => Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));

test(
  "transient GET failures have two bounded retries with exponential backoff",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const signals = [];
    const fetchFn = async (_url, init) => {
      signals.push(init.signal);
      calls++;
      return new Response("", { status: 503 });
    };
    await clocked(
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        const fiber = yield* Effect.forkChild(
          findAccountsEffect.pipe(Effect.provide(requestLiveLayer(env, fetchFn)), Effect.flip),
        );
        yield* TestClock.adjust("200 millis");
        yield* TestClock.adjust("400 millis");
        const error = yield* Fiber.join(fiber);
        assert.equal(error._tag, "YnabHttpError");
        assert.equal(error.status, 503);
        assert.equal(calls, 3);
        assert.equal(
          signals.every((signal) => signal.aborted),
          true,
        );
        assert.equal((yield* Clock.currentTimeMillis) - start, 600);
      }),
    );
  },
);

test("terminal GET failures and invalid payloads are not retried", async () => {
  for (const status of [401, 429, 200]) {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return new Response("{}", { status });
    };
    const error = await Effect.runPromise(
      findAccountsEffect.pipe(Effect.provide(requestLiveLayer(env, fetchFn)), Effect.flip),
    );
    assert.equal(error._tag, status === 200 ? "YnabResponseError" : "YnabHttpError");
    assert.equal(calls, 1);
  }
});

test("a transient GET failure can recover on the next attempt", { timeout: 5000 }, async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls === 1) throw new Error("temporary network failure");
    return Response.json({ data: { plans: [] } });
  };
  await clocked(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        findAccountsEffect.pipe(Effect.provide(requestLiveLayer(env, fetchFn))),
      );
      yield* TestClock.adjust("200 millis");
      assert.deepEqual(yield* Fiber.join(fiber), { matches: [], truncated: false });
      assert.equal(calls, 2);
    }),
  );
});

test("a server error after POST is uncertain and never retried", async () => {
  let writes = 0;
  const fetchFn = async (_url, init) => {
    if (init.method === "GET") return Response.json({ data: { account } });
    writes++;
    return new Response("private server diagnostics", { status: 503 });
  };
  const error = await Effect.runPromise(
    importPlanEffect(plan).pipe(Effect.provide(requestLiveLayer(env, fetchFn)), Effect.flip),
  );
  assert.equal(error._tag, "YnabImportBatchError");
  assert.equal(error.reason._tag, "YnabImportUncertainError");
  assert.deepEqual(error.reason.reason, { _tag: "Http", status: 503 });
  assert.equal(error.progress.uncertain, 1);
  assert.equal(writes, 1);
});

test(
  "a POST timeout aborts the transport and stays uncertain without retrying",
  { timeout: 5000 },
  async () => {
    let writes = 0;
    let aborted = false;
    let started;
    const postStarted = new Promise((resolve) => {
      started = resolve;
    });
    const fetchFn = async (_url, init) => {
      if (init.method === "GET") return Response.json({ data: { account } });
      writes++;
      started();
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    };
    await clocked(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          importPlanEffect(plan).pipe(Effect.provide(requestLiveLayer(env, fetchFn)), Effect.flip),
        );
        yield* Effect.promise(() => postStarted);
        yield* TestClock.adjust("10 seconds");
        const error = yield* Fiber.join(fiber);
        assert.equal(error._tag, "YnabImportBatchError");
        assert.equal(error.reason._tag, "YnabImportUncertainError");
        assert.deepEqual(error.reason.reason, { _tag: "Timeout" });
        assert.equal(error.progress.uncertain, 1);
        assert.equal(writes, 1);
        assert.equal(aborted, true);
      }),
    );
  },
);

test("oversized streaming uploads cancel the body and release the reader lock", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(3_000_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await worker.fetch(
    new Request("https://local.invalid/inspect", {
      method: "POST",
      headers: { Authorization: "Bearer upload" },
      body: stream,
      duplex: "half",
    }),
    env,
  );
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("aborting a request cancels a pending upload read", { timeout: 5000 }, async () => {
  let cancelled = false;
  let readStarted;
  const reading = new Promise((resolve) => {
    readStarted = resolve;
  });
  const stream = new ReadableStream({
    pull() {
      readStarted();
    },
    cancel() {
      cancelled = true;
    },
  });
  const abort = new AbortController();
  const request = new Request("https://local.invalid/inspect", {
    method: "POST",
    headers: { Authorization: "Bearer upload" },
    body: stream,
    duplex: "half",
    signal: abort.signal,
  });
  const pending = worker.fetch(request, env);
  await reading;
  abort.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test(
  "stalled uploads time out, cancel the stream and return HTTP 408",
  { timeout: 5000 },
  async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://local.invalid/inspect", {
      method: "POST",
      headers: { Authorization: "Bearer upload" },
      body: stream,
      duplex: "half",
    });
    await clocked(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          handleRequestEffect(request).pipe(Effect.provide(requestLiveLayer(env))),
        );
        yield* TestClock.adjust("30 seconds");
        const response = yield* Fiber.join(fiber);
        assert.equal(response.status, 408);
        assert.equal(cancelled, true);
        assert.equal(stream.locked, false);
      }),
    );
  },
);

test("telemetry records only bounded operation/outcome labels and elapsed duration", async () => {
  const registry = new Map();
  await clocked(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.sleep("50 millis").pipe(observeOperation("upload")),
      );
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(fiber);
      const duration = yield* Metric.value(
        Metric.withAttributes(operationDuration, { operation: "upload" }),
      );
      assert.equal(duration.count, 1);
      assert.equal(duration.sum, 50);
      const count = yield* Metric.value(
        Metric.withAttributes(operationCount, { operation: "upload", outcome: "success" }),
      );
      assert.equal(count.count, 1);
      yield* Effect.fail({ secret: "private-value" }).pipe(observeOperation("upload"), Effect.flip);
      const failures = yield* Metric.value(
        Metric.withAttributes(operationCount, { operation: "upload", outcome: "failure" }),
      );
      assert.equal(failures.count, 1);
      assert.equal(JSON.stringify(yield* Metric.snapshot).includes("private-value"), false);
    }).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  );
});

test("telemetry uses monotonic duration and records failures, defects and interruptions", async () => {
  const registry = new Map();
  const logs = [];
  const logger = Logger.make((options) => logs.push(options));
  const baseClock = Effect.runSync(Clock.Clock);
  let wall = 1_000_000_000n;
  let monotonic = 0n;
  const clock = {
    ...baseClock,
    currentTimeNanosUnsafe: () => wall,
    currentTimeNanos: Effect.sync(() => wall),
    currentTimeMillisUnsafe: () => Number(wall) / 1_000_000,
    currentTimeMillis: Effect.sync(() => Number(wall) / 1_000_000),
    monotonicTimeNanosUnsafe: () => monotonic,
    monotonicTimeNanos: Effect.sync(() => monotonic),
  };
  for (const outcome of [
    Effect.succeed({ secret: "private-result" }),
    Effect.fail({ secret: "private-failure" }),
    Effect.die({ secret: "private-defect" }),
    Effect.interrupt,
  ]) {
    await Effect.runPromiseExit(
      Effect.andThen(
        Effect.sync(() => {
          wall -= 100_000_000n;
          monotonic += 25_000_000n;
        }),
        outcome,
      ).pipe(
        observeOperation("upload"),
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.provide(Logger.layer([logger])),
      ),
    );
  }
  assert.deepEqual(
    logs.map((log) => log.message),
    ["success", "failure", "failure", "failure"].map((outcome) => [
      { event: "satispay.operation", operation: "upload", outcome, durationMs: 25 },
    ]),
  );
  assert.ok(logs.every((log) => log.cause.reasons.length === 0));
  await Effect.runPromise(
    Effect.gen(function* () {
      const duration = yield* Metric.value(
        Metric.withAttributes(operationDuration, { operation: "upload" }),
      );
      assert.equal(duration.count, 4);
      assert.equal(duration.sum, 100);
      const failures = yield* Metric.value(
        Metric.withAttributes(operationCount, { operation: "upload", outcome: "failure" }),
      );
      assert.equal(failures.count, 3);
      const successes = yield* Metric.value(
        Metric.withAttributes(operationCount, { operation: "upload", outcome: "success" }),
      );
      assert.equal(successes.count, 1);
    }).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  );
});

test("request composition emits structured console logs without upload contents or secrets", async () => {
  const logs = await Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* handleRequestEffect(
        new Request("https://local.invalid/inspect", {
          method: "POST",
          headers: { Authorization: "Bearer upload" },
          body: "name,amount\nprivate-payee,12.34\n",
        }),
      ).pipe(Effect.provide(requestLiveLayer(env)));
      assert.equal(response.status, 200);
      return yield* TestConsole.logLines;
    }).pipe(Effect.provide(TestConsole.layer)),
  );
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.equal(log.level, "INFO");
  assert.equal(log.message, "upload completed");
  assert.equal(log.event, "satispay.operation");
  assert.equal(log.operation, "upload");
  assert.equal(log.outcome, "success");
  assert.ok(Number.isFinite(log.durationMs) && log.durationMs >= 0);
  assert.equal(log.cause, undefined);
  assert.deepEqual(Object.keys(log).sort(), [
    "annotations",
    "cause",
    "durationMs",
    "event",
    "fiberId",
    "level",
    "message",
    "operation",
    "outcome",
    "spans",
    "timestamp",
  ]);
  for (const secret of ["private-payee", "12.34", "Bearer", env.YNAB_TOKEN]) {
    assert.equal(JSON.stringify(logs).includes(secret), false);
  }
});

test("operation formatter gives failures readable messages and preserves ordinary logs", async () => {
  const logs = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.fail({ secret: "private-failure" }).pipe(
        observeOperation("ynab.write"),
        Effect.flip,
      );
      yield* Effect.logInfo("ordinary message");
      return yield* TestConsole.logLines;
    }).pipe(Effect.provide(Logger.layer([operationLogger])), Effect.provide(TestConsole.layer)),
  );
  assert.equal(logs.length, 2);
  assert.equal(logs[0].message, "ynab.write failed");
  assert.equal(logs[0].event, "satispay.operation");
  assert.equal(logs[0].operation, "ynab.write");
  assert.equal(logs[0].outcome, "failure");
  assert.ok(Number.isFinite(logs[0].durationMs) && logs[0].durationMs >= 0);
  assert.equal(logs[0].cause, undefined);
  assert.equal(JSON.stringify(logs).includes("private-failure"), false);
  assert.equal(logs[1].message, "ordinary message");
  assert.equal(logs[1].operation, undefined);
});

test("malformed YNAB envelopes and payloads keep read and uncertain write failures without retries", async () => {
  for (const [body, readReason, writeReason] of [
    ["invalid JSON", "Json", "Json"],
    ["null", "Json", "Json"],
    ["{}", "Json", "Json"],
    [JSON.stringify({ data: null }), "Json", "Json"],
    [JSON.stringify({ data: false }), "Json", "Json"],
    [JSON.stringify({ data: {} }), "Plans", "Contract"],
  ]) {
    let reads = 0;
    const readError = await Effect.runPromise(
      findAccountsEffect.pipe(
        Effect.provide(
          requestLiveLayer(env, async () => {
            reads++;
            return new Response(body);
          }),
        ),
        Effect.flip,
      ),
    );
    assert.equal(readError._tag, "YnabResponseError");
    assert.equal(readError.reason, readReason);
    assert.equal(reads, 1);
    let writes = 0;
    const writeError = await Effect.runPromise(
      importPlanEffect(plan).pipe(
        Effect.provide(
          requestLiveLayer(env, async (_url, init) => {
            if (init.method === "GET") return Response.json({ data: { account } });
            writes++;
            return new Response(body);
          }),
        ),
        Effect.flip,
      ),
    );
    assert.equal(writeError._tag, "YnabImportBatchError");
    assert.equal(writeError.reason._tag, "YnabImportUncertainError");
    assert.deepEqual(writeError.reason.reason, { _tag: writeReason });
    assert.equal(writeError.progress.uncertain, 1);
    assert.equal(writes, 1);
  }
});
