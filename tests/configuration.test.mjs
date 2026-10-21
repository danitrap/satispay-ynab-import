import { test } from "node:test";
import { strict as assert } from "node:assert";
import worker from "../src/index.ts";
import { Effect } from "effect";
import { handleRequestEffect } from "../src/index.ts";
import { requestLiveLayer, findAccountsEffect } from "../src/ynab-service.ts";

test("account discovery reports missing configuration without exposing bindings", async () => {
  const response = await worker.fetch(
    new Request("https://local.invalid/ynab/accounts", {
      headers: { Authorization: "Bearer upload-secret" },
    }),
    { UPLOAD_TOKEN: "upload-secret" },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: "Missing YNAB_TOKEN secret" });
});

test("health and CSV inspection ignore unrelated invalid YNAB configuration", async () => {
  const env = {
    UPLOAD_TOKEN: "upload-secret",
    YNAB_TOKEN: " ",
    YNAB_IMPORT_FROM: "bad",
    YNAB_WRITE_ENABLED: "yes",
  };
  const health = await worker.fetch(new Request("https://local.invalid/health"), {});
  assert.equal(health.status, 200);
  const inspection = await worker.fetch(
    new Request("https://local.invalid/inspect", {
      method: "POST",
      headers: { Authorization: "Bearer upload-secret" },
      body: "Data;Importo\n2026-10-18;-5\n",
    }),
    env,
  );
  assert.equal(inspection.status, 200);
  assert.equal((await inspection.json()).rowCount, 1);
});

test("invalid secrets never appear in typed configuration failures or HTTP responses", async () => {
  const env = { UPLOAD_TOKEN: "upload-secret", YNAB_TOKEN: " secret-with-invalid-whitespace " };
  const error = await Effect.runPromise(
    findAccountsEffect.pipe(Effect.provide(requestLiveLayer(env)), Effect.flip),
  );
  assert.equal(error._tag, "ConfigurationError");
  assert.equal(error.key, "YNAB_TOKEN");
  assert.equal(JSON.stringify(error).includes("secret-with-invalid-whitespace"), false);
  const response = await Effect.runPromise(
    handleRequestEffect(
      new Request("https://local.invalid/ynab/accounts", {
        headers: { Authorization: "Bearer upload-secret" },
      }),
    ).pipe(Effect.provide(requestLiveLayer(env))),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes("secret-with-invalid-whitespace"), false);
});

test("concurrent requests use only their own YNAB credentials", async () => {
  const authorizations = [];
  const fetchFn = async (_url, init) => {
    authorizations.push(new Headers(init.headers).get("Authorization"));
    return Response.json({ data: { plans: [] } });
  };
  await Promise.all(
    ["first-secret", "second-secret"].map((token) =>
      Effect.runPromise(
        findAccountsEffect.pipe(Effect.provide(requestLiveLayer({ YNAB_TOKEN: token }, fetchFn))),
      ),
    ),
  );
  assert.deepEqual(authorizations.sort(), ["Bearer first-secret", "Bearer second-secret"]);
});
