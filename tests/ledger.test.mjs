import {test} from "node:test";
import {strict as assert} from "node:assert";
import {analyzeLedger} from "../src/ledger.ts";
import {buildImportPlan} from "../src/import-plan.ts";
import {previewSatispay} from "../src/preview.ts";

const headers=["Data","Nome","Descrizione","Importo","Tipo","Stato","Disponibilità","Buoni Pasto","FlexBen","Disponibilità dopo la transazione","ID (Comunicalo all'Assistenza Clienti in caso di problemi)"];
const date=(day,hour=12)=>new Date(`2026-08-${String(day).padStart(2,"0")}T${String(hour).padStart(2,"0")}:00:00.000Z`);
const row=(d,name,nominal,type,available,meal,balance,id,flex=null)=>[d,name,"",nominal,type,"✅ Approvato",available,meal,flex,balance,id];

const sample=[headers,
  row(date(28,18),"Cafe A",20.23,"🔄 Rimborso",20.23,null,200,"refund-a"),
  row(date(28,17),"Cafe A",-20.23,"🏬 a un Negozio",-4.23,-16,195.77,"purchase-a"),
  row(date(20,18),"Cafe B",19,"🔄 Rimborso",19,null,200,"refund-b"),
  row(date(20,17),"Cafe B",-19,"🏬 a un Negozio",-3,-16,197,"purchase-b"),
  row(date(19), "Bank",100,"🏦 Dalla Banca",100,null,200,"bank"),
  row(date(18), "Shop",-5,"🏬 a un Negozio",-5,null,100,"old")
];
test("mixed meal-voucher refunds match original purchase and only restore wallet amount",()=>{
  const audit=analyzeLedger(sample);
  assert.equal(audit.refundsAdjusted,2);
  assert.equal(audit.refundsUnresolved,0);
  assert.equal(audit.resolved[0].amountCents,423);
  assert.equal(audit.resolved[2].amountCents,300);
  assert.deepEqual(audit.balanceCheck,{
    status:"ok",expectedChangeMilliunits:100000,calculatedChangeMilliunits:100000,discrepancyMilliunits:0
  });
  const plan=buildImportPlan(sample,"2026-08-18");
  assert.equal(plan.candidates.find(x=>x.satispayId==="refund-a").amountMilliunits,4230);
  assert.equal(plan.candidates.find(x=>x.satispayId==="refund-b").amountMilliunits,3000);
  assert.equal(plan.refundsAdjusted,2);
  assert.equal(plan.balanceCheck.status,"ok");
  const preview=previewSatispay(sample);
  assert.equal(preview.refundsAdjusted,2);
  assert.equal(preview.balanceCheck.discrepancyMilliunits,0);
  assert.equal(preview.requiresReview,0);
});
test("missing merchant original never imports unverified full refund",()=>{
 const data=[headers,row(date(28),"Cafe",20.23,"🔄 Rimborso",20.23,null,100,"refund")];
 const audit=analyzeLedger(data);
 assert.equal(audit.refundsUnresolved,1);
 assert.equal(audit.resolved[0].issue,"refund_purchase_not_in_export");
 const preview=previewSatispay(data);
 assert.equal(preview.requiresReview,1);
 const plan=buildImportPlan(data,"2026-08-01");
 assert.equal(plan.counts.rejected,1);
 assert.equal(plan.candidates.length,0);
});
test("ambiguous same-merchant equal-amount purchases are not guessed",()=>{
 const rows=[headers,
  row(date(28),"Cafe",20.23,"🔄 Rimborso",20.23,null,200,"refund"),
  row(date(28,11),"Cafe",-20.23,"🏬 a un Negozio",-4.23,-16,195.77,"purchase-1"),
  row(date(27),"Cafe",-20.23,"🏬 a un Negozio",-12.23,-8,200,"purchase-2")
 ];
 const r=analyzeLedger(rows);
 assert.equal(r.resolved[0].issue,"ambiguous_refund_purchase");
});
test("a full voucher refund leads to a zero wallet amount and is skipped",()=>{
 const rows=[headers,
  row(date(28),"Cafe",16,"🔄 Rimborso",16,null,100,"refund"),
  row(date(27),"Cafe",-16,"🏬 a un Negozio",null,-16,100,"original")
 ];
 const audit=analyzeLedger(rows);
 assert.equal(audit.resolved[0].amountCents,0);
 const plan=buildImportPlan(rows,"2026-08-01");
 assert.equal(plan.candidates.length,0);
 assert.equal(plan.counts.withoutAvailability,2);
});
test("non-refund unknown types remain importable; input IDs stay stable",()=>{
 const rows=[headers,row(date(28),"-",-12.50,"Altro",-12.50,null,90,"unknown")];
 const p=buildImportPlan(rows,"2026-08-01");
 assert.equal(p.candidates.length,1);
 assert.equal(p.candidates[0].amountMilliunits,-12500);
 assert.equal(p.candidates[0].satispayId,"unknown");
});
test("global balance audit tolerates out-of-order intermediate card settlements",()=>{
 const data=[headers,
   row(date(28),"Bank",30,"🏦 Dalla Banca",30,null,120,"one"),
   row(date(27),"Card",-10,"Carta ••2156",-10,null,105,"two"),
   row(date(26),"Old",-1,"Altro",-1,null,100,"three")
 ];
 const check=analyzeLedger(data).balanceCheck;
 assert.equal(check.status,"ok");
 assert.equal(check.discrepancyMilliunits,0);
});
test("balance audit detects a discrepancy without blocking normal transactions",()=>{
 const data=[headers,
   row(date(28),"Bank",30,"🏦 Dalla Banca",30,null,150,"one"),
   row(date(27),"Card",-10,"Carta ••2156",-10,null,105,"two"),
   row(date(26),"Old",-1,"Altro",-1,null,100,"three")
 ];
 const check=analyzeLedger(data).balanceCheck;
 assert.equal(check.status,"mismatch");
 assert.equal(check.discrepancyMilliunits,30000);
 const p=buildImportPlan(data,"2026-08-01");
 assert.equal(p.counts.rejected,0);
});
