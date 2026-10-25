import { timingSafeEqual } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import worker from "../src/index.ts";

const token = "test-secret";
const csv = "Data;Descrizione;Importo\n2026-10-18;Caffe;-3,50\n";

function upload(authorization, address) {
  const headers = { "Content-Type": "application/octet-stream" };
  if (authorization !== undefined) headers.Authorization = authorization;
  if (address !== undefined) headers["CF-Connecting-IP"] = address;
  return new Request("https://local.invalid/inspect", {
    method: "POST",
    headers,
    body: csv,
  });
}

function bindings(limiter) {
  return {
    UPLOAD_TOKEN: token,
    ...(limiter ? { AUTH_FAILURE_LIMITER: limiter } : {}),
  };
}

test("accepts the configured upload token", async () => {
  const response = await worker.fetch(upload(`Bearer ${token}`), bindings());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.format, "csv");
  assert.equal(body.imported, 0);
});

test("rejects a wrong upload token", async () => {
  const response = await worker.fetch(upload("Bearer test-secreX"), bindings());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized" });
});

test("rejects a different-length upload token", async () => {
  const response = await worker.fetch(upload("Bearer no"), bindings());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized" });
});

test("rejects a missing authorization header", async () => {
  const response = await worker.fetch(upload(), bindings());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized" });
});

test("returns 429 when failed authentication attempts are exhausted", async () => {
  const keys = [];
  const limiter = {
    async limit({ key }) {
      keys.push(key);
      return { success: keys.length < 2 };
    },
  };
  const env = bindings(limiter);
  const first = await worker.fetch(upload("Bearer no", "203.0.113.10"), env);
  assert.equal(first.status, 401);
  const second = await worker.fetch(upload("Bearer test-secreX", "203.0.113.10"), env);
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), {
    ok: false,
    error: "Too many failed authentication attempts",
  });
  assert.deepEqual(keys, ["203.0.113.10", "203.0.113.10"]);
  assert.equal(JSON.stringify(keys).includes(token), false);
});

test("invokes crypto.subtle.timingSafeEqual with crypto.subtle as this", async () => {
  const calls = [];
  const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual");
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    writable: true,
    value(left, right) {
      if (this !== crypto.subtle) throw new TypeError("Illegal invocation");
      calls.push([left.byteLength, right.byteLength]);
      if (left.byteLength !== right.byteLength) throw new Error("timingSafeEqual length mismatch");
      return timingSafeEqual(left, right);
    },
  });
  try {
    const accepted = await worker.fetch(upload(`Bearer ${token}`), bindings());
    const wrong = await worker.fetch(upload("Bearer test-secreX"), bindings());
    assert.equal(accepted.status, 200);
    assert.equal(wrong.status, 401);
    assert.equal(calls.length >= 2, true);
    assert.equal(
      calls.every(([left, right]) => left === right),
      true,
    );
  } finally {
    if (descriptor) Object.defineProperty(crypto.subtle, "timingSafeEqual", descriptor);
    else delete crypto.subtle.timingSafeEqual;
  }
});

test("compares different-length tokens with crypto.subtle.timingSafeEqual", async () => {
  const calls = [];
  const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual");
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    writable: true,
    value(left, right) {
      calls.push([left.byteLength, right.byteLength]);
      if (left.byteLength !== right.byteLength) throw new Error("timingSafeEqual length mismatch");
      return timingSafeEqual(left, right);
    },
  });
  try {
    const wrongLength = await worker.fetch(upload("Bearer short"), bindings());
    const wrongToken = await worker.fetch(upload("Bearer test-secreX"), bindings());
    const accepted = await worker.fetch(upload(`Bearer ${token}`), bindings());
    assert.equal(wrongLength.status, 401);
    assert.equal(wrongToken.status, 401);
    assert.equal(accepted.status, 200);
    assert.equal(calls.length >= 3, true);
    assert.equal(
      calls.every(([left, right]) => left === right),
      true,
    );
  } finally {
    if (descriptor) Object.defineProperty(crypto.subtle, "timingSafeEqual", descriptor);
    else delete crypto.subtle.timingSafeEqual;
  }
});

test("a correct token does not consume the failure limiter", async () => {
  let calls = 0;
  const response = await worker.fetch(upload(`Bearer ${token}`), {
    UPLOAD_TOKEN: token,
    AUTH_FAILURE_LIMITER: {
      async limit() {
        calls += 1;
        return { success: false };
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

test("limits each client address separately", async () => {
  const limiter = {
    async limit({ key }) {
      return { success: key !== "203.0.113.9" };
    },
  };
  const blocked = await worker.fetch(upload("Bearer no", "203.0.113.9"), bindings(limiter));
  const other = await worker.fetch(upload("Bearer no", "198.51.100.8"), bindings(limiter));
  assert.equal(blocked.status, 429);
  assert.equal(other.status, 401);
});

test("uses the client IP as the limiter key", async () => {
  const keys = [];
  const limiter = {
    async limit({ key }) {
      keys.push(key);
      return { success: true };
    },
  };
  const env = bindings(limiter);
  await worker.fetch(upload("Bearer no", "  2001:db8::10  "), env);
  await worker.fetch(upload("Bearer no", `Bearer ${token}`), env);
  await worker.fetch(upload("Bearer no"), env);
  assert.deepEqual(keys, ["2001:db8::10", "unknown-client", "unknown-client"]);
});

test("a failing limiter still rejects the credential", async () => {
  const response = await worker.fetch(upload("Bearer no"), {
    UPLOAD_TOKEN: token,
    AUTH_FAILURE_LIMITER: {
      async limit() {
        throw new Error(`down ${token}`);
      },
    },
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.deepEqual(body, { ok: false, error: "Unauthorized" });
  assert.equal(JSON.stringify(body).includes(token), false);
});

test("missing upload token does not consult the limiter", async () => {
  let calls = 0;
  const response = await worker.fetch(upload(`Bearer ${token}`), {
    AUTH_FAILURE_LIMITER: {
      async limit() {
        calls += 1;
        return { success: false };
      },
    },
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized" });
});

test("health does not consume the auth failure limiter", async () => {
  let calls = 0;
  const response = await worker.fetch(new Request("https://local.invalid/health"), {
    UPLOAD_TOKEN: token,
    AUTH_FAILURE_LIMITER: {
      async limit() {
        calls += 1;
        return { success: false };
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});
