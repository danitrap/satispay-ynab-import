import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { handleRequestEffect } from "../src/index.ts";
import { sendToYnabEffect, importIdEffect, YnabError } from "../src/ynab.ts";
import { readSheetEffect, WorkbookError } from "../src/spreadsheet.ts";

test("Cloudflare request handler is an Effect and retains unauthorized protection", async()=>{
  const program=handleRequestEffect(new Request("https://example.invalid/import",{method:"POST"}),{UPLOAD_TOKEN:"secret"});
  assert.equal(Effect.isEffect(program),true);
  const res=await Effect.runPromise(program);
  assert.equal(res.status,401);
});
test("Effect YNAB program prevents writes while disabled",async()=>{
  const plan={counts:{rejected:0},candidates:[]};
  const result=await Effect.runPromiseExit(sendToYnabEffect(plan,{YNAB_WRITE_ENABLED:"false"}));
  assert.equal(result._tag,"Failure");
});
test("Effect SHA-256 import ids preserve deterministic legacy form",async()=>{
  const a=await Effect.runPromise(importIdEffect("a-stable-id"));
  const b=await Effect.runPromise(importIdEffect("a-stable-id"));
  assert.equal(a,b);
  assert.equal(a.length,36);
  assert.match(a,/^SPS:[a-f0-9]{32}$/);
});
test("invalid Excel produces typed WorkbookError",async()=>{
  const result=await Effect.runPromiseExit(readSheetEffect(new TextEncoder().encode("not a workbook").buffer));
  assert.equal(result._tag,"Failure");
});
