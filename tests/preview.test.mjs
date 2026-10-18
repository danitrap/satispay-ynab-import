import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {previewSatispay} from '../src/preview.ts';

const hdr=['Data','Nome','Descrizione','Importo','Tipo','Stato','Disponibilità','Buoni Pasto','FlexBen','Disponibilità dopo la transazione',"ID (Comunicalo all'Assistenza Clienti in caso di problemi)"];
const day=new Date('2026-10-17T00:00:00.000Z');
test('only moves in Disponibilità and no benefits spending',()=>{
  const p=previewSatispay([hdr,
    [day,'Shop','foo',-20,'🏬 a un Negozio','✅ Approvato',-5,-15,null,95,'a'],
    [day,'Shop','meal',-8,'🏬 a un Negozio','✅ Approvato',null,-8,null,null,'b'],
    [day,'Satispay','cashback',3,'🎖️ Punti','✅ Approvato',3,null,null,98,'c'],
    [day,'Pension','pension',-100,'al Fondo Pensioni','✅ Approvato',null,null,-100,null,'d']
  ]);
  assert.deepEqual([p.eligible,p.skipped,p.requiresReview],[2,2,0]);
  assert.equal(p.outflowEur,5);
  assert.equal(p.inflowEur,3);
  assert.equal(p.netEur,-2);
  assert.equal(JSON.stringify(p).includes('Shop'),false);
  assert.equal(JSON.stringify(p).includes('"a"'),false);
});
test('unknown movement and top-up must be reviewed',()=>{
 const p=previewSatispay([hdr,[day,'Bank','recharge',50,'Ricarica','✅ Approvato',50,null,null,150,'abc']]);
 assert.equal(p.requiresReview,1);assert.equal(p.eligible,0);
});
test('identical IDs and bad statuses are blocked, zero values skipped',()=>{
 const p=previewSatispay([hdr,
  [day,'x','',-1,'🏬 a un Negozio','✅ Approvato',-1,null,null,90,'same'],
  [day,'x','',-1,'🏬 a un Negozio','✅ Approvato',-1,null,null,90,'same'],
  [day,'x','',-1,'🏬 a un Negozio','In attesa',-1,null,null,90,'other'],
  [day,'x','',0,'🏬 a un Negozio','✅ Approvato',0,null,null,90,'four'],
 ]);
 assert.equal(p.eligible,0);assert.equal(p.requiresReview,3);assert.equal(p.skipped,1);
 assert.equal(p.byReason.missing_or_duplicate_id,2);
});
