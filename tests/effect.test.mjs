import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { handleRequestEffect } from "../src/index.ts";
import { importIdEffect } from "../src/ynab.ts";
import { ynabLiveLayer, importPlanEffect, findAccountsEffect } from "../src/ynab-service.ts";
import { readSheetEffect, WorkbookError } from "../src/spreadsheet.ts";

test("Cloudflare request handler is an Effect and retains unauthorized protection", async()=>{
  const program=handleRequestEffect(new Request("https://example.invalid/import",{method:"POST"}),{UPLOAD_TOKEN:"secret"});
  assert.equal(Effect.isEffect(program),true);
  const res=await Effect.runPromise(program);
  assert.equal(res.status,401);
});
test("Effect YNAB program prevents writes while disabled",async()=>{
  const plan={counts:{rejected:0},candidates:[]};
  const result=await Effect.runPromiseExit(importPlanEffect(plan).pipe(Effect.provide(ynabLiveLayer({YNAB_WRITE_ENABLED:"false"}))));
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

test("Effect decodes YNAB plans instead of trusting an untyped response",async()=>{
  const fetchFn=async()=>new Response(JSON.stringify({data:{plans:[{id:123,name:"wrong"}]}}),{status:200});
  await assert.rejects(
    Effect.runPromise(findAccountsEffect.pipe(Effect.provide(ynabLiveLayer({YNAB_TOKEN:"test"},fetchFn)))),
    /Cannot list YNAB plans/
  );
});
test("Effect validates account schema and never posts to unexpected account data",async()=>{
  const plan={counts:{rejected:0},candidates:[{satispayId:"a",date:"2026-10-18",payee:"Shop",memo:"",amountMilliunits:-1000,type:"Altro"}]};
  const env={YNAB_TOKEN:"test",YNAB_PLAN_ID:"plan",YNAB_ACCOUNT_ID:"target",YNAB_WRITE_ENABLED:"true"};
  let postCount=0;
  const fetchFn=async(_url,options)=>{
    if(options.method==="POST")postCount++;
    return new Response(JSON.stringify({data:{account:{id:"target",name:"Satispay",closed:false,on_budget:"true"}}}),{status:200});
  };
  await assert.rejects(Effect.runPromise(importPlanEffect(plan).pipe(Effect.provide(ynabLiveLayer(env,fetchFn)))),/Target must be/);
  assert.equal(postCount,0);
});
test("Effect refuses malformed successful YNAB POST responses without retrying writes",async()=>{
  const plan={counts:{rejected:0},candidates:[{satispayId:"unique",date:"2026-10-18",payee:"Shop",memo:"",amountMilliunits:-1500,type:"Altro"}]};
  const env={YNAB_TOKEN:"test",YNAB_PLAN_ID:"plan",YNAB_ACCOUNT_ID:"target",YNAB_WRITE_ENABLED:"true"};
  let writes=0;
  const fetchFn=async(_url,options)=>{
    if(options.method==="GET")return new Response(JSON.stringify({data:{account:{id:"target",name:"Satispay",closed:false,on_budget:true}}}),{status:200});
    writes++;
    return new Response(JSON.stringify({data:{transaction_ids:["tx-1"],duplicate_import_ids:"not-an-array"}}),{status:200});
  };
  await assert.rejects(Effect.runPromise(importPlanEffect(plan).pipe(Effect.provide(ynabLiveLayer(env,fetchFn)))),/Unexpected YNAB response/);
  assert.equal(writes,1);
});
test("Effect import response distinguishes matched IDs from actual imported movements",async()=>{
  const plan={counts:{rejected:0},candidates:[{satispayId:"unique",date:"2026-10-18",payee:"Shop",memo:"",amountMilliunits:-1500,type:"Altro"}]};
  const env={YNAB_TOKEN:"test",YNAB_PLAN_ID:"plan",YNAB_ACCOUNT_ID:"target",YNAB_WRITE_ENABLED:"true"};
  const fetchFn=async(_url,options)=>{
    if(options.method==="GET")return new Response(JSON.stringify({data:{account:{id:"target",name:"Satispay",closed:false,on_budget:true}}}),{status:200});
    return new Response(JSON.stringify({data:{transaction_ids:["original","matched"],duplicate_import_ids:[]}}),{status:200});
  };
  const result=await Effect.runPromise(importPlanEffect(plan).pipe(Effect.provide(ynabLiveLayer(env,fetchFn))));
  assert.deepEqual(result,{submitted:1,processed:1,duplicateImports:0,ynabReportedTransactionIds:2});
});
test("Effect preserves input ordering when hashing imported IDs concurrently",async()=>{
  const {buildYnabTransactionsEffect}=await import("../src/ynab.ts");
  const rows=["first","second","third","fourth","fifth"].map(satispayId=>({
    satispayId,date:"2026-10-18",payee:satispayId,memo:"",amountMilliunits:-1000,type:"Altro"
  }));
  const transactions=await Effect.runPromise(buildYnabTransactionsEffect(rows,"account"));
  assert.deepEqual(transactions.map(t=>t.payee_name),rows.map(x=>x.payee));
  assert.equal(new Set(transactions.map(t=>t.import_id)).size,rows.length);
});
