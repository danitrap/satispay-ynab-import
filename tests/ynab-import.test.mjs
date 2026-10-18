import {test} from "node:test";
import {strict as assert} from "node:assert";
import {buildImportPlan,summarizeImportPlan} from "../src/import-plan.ts";
import {importId,buildYnabTransactions,sendToYnab,findSatispayAccounts} from "../src/ynab.ts";

const headers=["Data","Nome","Descrizione","Importo","Tipo","Stato","Disponibilità","Buoni Pasto","FlexBen","Disponibilità dopo la transazione","ID (Comunicalo all'Assistenza Clienti in caso di problemi)"];
const day=new Date("2026-10-18T00:00:00.000Z");
const row=(id,amount,type="🏬 a un Negozio",when=day,other={})=>
  [when,"Negozio A","Acquisto",amount,type,"✅ Approvato",amount,null,null,100,id,...[]];

test("imports wallet portion, skips meal vouchers and already reconciled dates",()=>{
  const plan=buildImportPlan([headers,
    [day,"Bar","Pranzo",-20,"🏬 a un Negozio","✅ Approvato",-5,-15,null,95,"tx-a"],
    [day,"Bar","Buoni",-15,"🏬 a un Negozio","✅ Approvato",null,-15,null,null,"tx-b"],
    [day,"Satispay","Punti",2.99,"🎖️ Punti","✅ Approvato",2.99,null,null,97.99,"tx-c"],
    [new Date("2026-10-01T00:00:00.000Z"),"Bar","Vecchio",-5,"🏬 a un Negozio","✅ Approvato",-5,null,null,90,"tx-old"]
  ],"2026-10-15");
  assert.equal(plan.candidates.length,2);
  assert.deepEqual(plan.candidates.map(x=>x.amountMilliunits),[-5000,2990]);
  assert.equal(plan.counts.withoutAvailability,1);
  assert.equal(plan.counts.olderThanStart,1);
  assert.equal(summarizeImportPlan(plan).netMilliunits,-2010);
});
test("duplicate IDs and unknown Fineco topups are blocked",()=>{
  const plan=buildImportPlan([headers,
    row("dup",-4),
    row("dup",-2),
    row("topup",50,"Ricarica")
  ],"2026-10-01");
  assert.equal(plan.candidates.length,0);
  assert.equal(plan.issues.missing_nontext_or_duplicate_id,2);
  assert.equal(plan.issues.unknown_or_transfer_type,1);
});
test("import IDs are deterministic, privacy preserving and at most 36 chars",async()=>{
  const a=await importId("external-private-id-123");
  assert.equal(a.length,36);
  assert.equal(a,await importId("external-private-id-123"));
  assert.notEqual(a,await importId("external-private-id-124"));
  assert.equal(a.includes("external"),false);
});
test("YNAB payload uses imported cleared unapproved transactions",async()=>{
  const plan=buildImportPlan([headers,row("a",-12.34)],"2026-10-01");
  const payload=await buildYnabTransactions(plan.candidates,"account-uuid");
  assert.equal(payload[0].amount,-12340);
  assert.equal(payload[0].approved,false);
  assert.equal(payload[0].cleared,"cleared");
  assert.equal(payload[0].account_id,"account-uuid");
  assert.equal(payload[0].import_id.length,36);
});
test("writes disabled means zero YNAB requests",async()=>{
  const plan=buildImportPlan([headers,row("a",-2)],"2026-10-01");
  let requests=0;
  const mock=async()=>{requests++;throw Error("should not fetch");};
  await assert.rejects(sendToYnab(plan,{YNAB_WRITE_ENABLED:"false"},mock),/disabled/);
  assert.equal(requests,0);
});
test("blocks writes on non-Satispay target account",async()=>{
  const plan=buildImportPlan([headers,row("a",-2)],"2026-10-01");
  let writes=0;
  const mock=async(_url,init)=>{
    if(init.method==="POST")writes++;
    return new Response(JSON.stringify({data:{account:{id:"target",name:"Revolut",on_budget:true,closed:false}}}),{status:200});
  };
  await assert.rejects(sendToYnab(plan,{YNAB_TOKEN:"fake",YNAB_PLAN_ID:"plan",YNAB_ACCOUNT_ID:"target",YNAB_WRITE_ENABLED:"true"},mock),/Satispay/);
  assert.equal(writes,0);
});
test("YNAB import accepts successful batch with duplicate_import_ids",async()=>{
  const plan=buildImportPlan([headers,row("a",-12.34)],"2026-10-01");
  const calls=[];
  const mock=async(url,init)=>{
    calls.push({url:String(url),method:init.method,body:init.body?JSON.parse(init.body):null});
    if(init.method==="GET")return new Response(JSON.stringify({data:{account:{id:"target",name:"Satispay",on_budget:true,closed:false}}}),{status:200});
    return new Response(JSON.stringify({data:{transaction_ids:["trans-1"],duplicate_import_ids:[]}}),{status:200});
  };
  const result=await sendToYnab(plan,{YNAB_TOKEN:"fake",YNAB_PLAN_ID:"plan",YNAB_ACCOUNT_ID:"target",YNAB_WRITE_ENABLED:"true"},mock);
  assert.deepEqual(result,{submitted:1,acceptedOrMatched:1,duplicateImports:0});
  assert.match(calls[1].url,/\/v1\/plans\/plan\/transactions$/);
  assert.equal(calls[1].body.transactions[0].payee_name,"Negozio A");
});
test("account discovery only returns accounts named Satispay",async()=>{
 const mock=async url=>new Response(JSON.stringify({
   data:String(url).endsWith("/plans")
   ?{plans:[{id:"plan-1",name:"Budget"}]}
   :{accounts:[{id:"sat",name:"Satispay",on_budget:true,closed:false},{id:"rev",name:"Revolut",on_budget:true,closed:false}]}
 }),{status:200});
 const r=await findSatispayAccounts({YNAB_TOKEN:"test"},mock);
 assert.equal(r.matches.length,1);
 assert.equal(r.matches[0].accountId,"sat");
});
