import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Effect } from "effect";
import { YnabError } from "../src/ynab.ts";
import { YnabService, ynabTestLayer, ynabLiveLayer, findAccountsEffect, importPlanEffect } from "../src/ynab-service.ts";

const plan={counts:{rejected:0},candidates:[]};
const stub={
  findAccounts: Effect.succeed({matches:[{planId:"test",planName:"Budget",accountId:"wallet",accountName:"Satispay",onBudget:true}]}),
  validateAccount: Effect.succeed({id:"wallet",name:"Satispay",on_budget:true,closed:false}),
  importPlan: () => Effect.succeed({submitted:1,processed:0,duplicateImports:1,ynabReportedTransactionIds:0})
};

test("test Layer supplies an isolated YNAB service without any HTTP",()=>{
  const program=Effect.gen(function*(){
    const service=yield* YnabService;
    assert.equal(typeof service.importPlan,"function");
    const accounts=yield* findAccountsEffect;
    const outcome=yield* importPlanEffect(plan);
    return {accounts,outcome};
  });
  return Effect.runPromise(program.pipe(Effect.provide(ynabTestLayer(stub)))).then(result=>{
    assert.equal(result.accounts.matches[0].accountName,"Satispay");
    assert.equal(result.outcome.duplicateImports,1);
    assert.equal(result.outcome.processed,0);
  });
});

test("test Layer failures remain typed Effect failures",()=>{
  const layer=ynabTestLayer({
    ...stub,
    importPlan:()=>Effect.fail(new YnabError("Simulated YNAB failure"))
  });
  return Effect.runPromiseExit(importPlanEffect(plan).pipe(Effect.provide(layer))).then(exit=>{
    assert.equal(exit._tag,"Failure");
  });
});

test("live Layer with fake transport rejects malformed YNAB account before any POST",()=>{
  let posts=0;
  const mockFetch=async (_url,init)=>{
    if(init?.method==="POST")posts++;
    return new Response(JSON.stringify({data:{account:{id:"wallet",name:"Satispay",on_budget:"yes",closed:false}}}),{status:200});
  };
  const env={YNAB_TOKEN:"fake",YNAB_PLAN_ID:"plan",YNAB_ACCOUNT_ID:"wallet",YNAB_WRITE_ENABLED:"true"};
  const candidate={satispayId:"test",date:"2026-10-18",amountMilliunits:-1000,payee:"Shop",memo:"",type:"Altro"};
  const populated={counts:{rejected:0},candidates:[candidate]};
  return assert.rejects(
    Effect.runPromise(importPlanEffect(populated).pipe(Effect.provide(ynabLiveLayer(env,mockFetch)))),
    /Target must be/
  ).then(()=>assert.equal(posts,0));
});

test("disabled live Layer prevents all network calls",()=>{
  let calls=0;
  const mockFetch=async()=>{calls++;throw new Error("Should not call network");};
  const env={YNAB_WRITE_ENABLED:"false"};
  return assert.rejects(
    Effect.runPromise(importPlanEffect(plan).pipe(Effect.provide(ynabLiveLayer(env,mockFetch)))),
    /disabled/
  ).then(()=>assert.equal(calls,0));
});
