import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Clock, Effect, Fiber, Metric } from "effect";
import { TestClock } from "effect/testing";
import { findAccountsEffect, importPlanEffect, requestLiveLayer } from "../src/ynab-service.ts";
import worker, { handleRequestEffect } from "../src/index.ts";
import { operationCount, operationDuration, observeOperation } from "../src/telemetry.ts";

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
      assert.deepEqual(yield* Fiber.join(fiber), { matches: [] });
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
  assert.equal(error._tag, "YnabImportUncertainError");
  assert.equal(error.reason, "Http");
  assert.equal(error.status, 503);
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
        assert.equal(error._tag, "YnabImportUncertainError");
        assert.equal(error.reason, "Timeout");
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
