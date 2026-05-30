import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { normalizeCode, computeDiscount, validateDiscount } from '../src/services/discountService.js';
import { ApiError } from '../src/services/registration.js';

function reset(){ db.exec("DELETE FROM discount_redemptions WHERE phone LIKE '0994%'; DELETE FROM discount_codes WHERE code LIKE 'TESTD%';"); }
function expect(l,fn){ try{fn();console.log('  ✓ '+l);}catch(e){console.log('  ✗ '+l);console.error(e);process.exitCode=1;} }
function mk(fields){ const cols=Object.keys(fields); const qs=cols.map(()=>'?').join(','); db.prepare(`INSERT INTO discount_codes (${cols.join(',')}) VALUES (${qs})`).run(...cols.map(c=>fields[c])); return db.prepare('SELECT id FROM discount_codes WHERE code=?').get(fields.code).id; }

console.log('[discount-service] start'); reset();

expect('normalizeCode trims+uppercases', ()=>assert.equal(normalizeCode('  abc12 '),'ABC12'));
expect('computeDiscount percent floors', ()=>assert.deepEqual(computeDiscount('percent',10,1050),{discountAmount:105,finalTotal:945}));
expect('computeDiscount fixed caps at subtotal', ()=>assert.deepEqual(computeDiscount('fixed',800,500),{discountAmount:500,finalTotal:0}));

mk({code:'TESTD10', discount_type:'percent', discount_value:10, active:1});
expect('validate percent ok', ()=>{ const v=validateDiscount({code:'testd10',phone:'0994000001',subtotal:1000}); assert.equal(v.discountAmount,100); assert.equal(v.finalTotal,900); });
expect('invalid code → 404', ()=>{ try{validateDiscount({code:'NOPE',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.status,404);assert.equal(e.code,'invalid_code');} });

mk({code:'TESTD_OFF', discount_type:'fixed', discount_value:100, active:0});
expect('inactive → 409 code_inactive', ()=>{ try{validateDiscount({code:'TESTD_OFF',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'code_inactive');} });

mk({code:'TESTD_EXP', discount_type:'fixed', discount_value:100, active:1, valid_until:'2000-01-01'});
expect('expired → code_expired', ()=>{ try{validateDiscount({code:'TESTD_EXP',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'code_expired');} });

mk({code:'TESTD_FUT', discount_type:'fixed', discount_value:100, active:1, valid_from:'2999-01-01'});
expect('not started → code_not_started', ()=>{ try{validateDiscount({code:'TESTD_FUT',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'code_not_started');} });

mk({code:'TESTD_MIN', discount_type:'fixed', discount_value:100, active:1, min_amount:2000});
expect('below min → below_min_amount', ()=>{ try{validateDiscount({code:'TESTD_MIN',phone:'0994000001',subtotal:1000});assert.fail();}catch(e){assert.equal(e.code,'below_min_amount');} });

console.log('[discount-service] D2 done');

import { applyDiscountTx, releaseRedemption } from '../src/services/discountService.js';
import { tx } from '../src/db/connection.js';

console.log('[discount-service] D3 start');
const idMax = mk({code:'TESTD_MAX', discount_type:'fixed', discount_value:100, active:1, max_uses:1});
expect('apply records redemption + returns folded', ()=>{
  const r = tx(()=>applyDiscountTx({code:'TESTD_MAX',phone:'0994000010',subtotal:500,kind:'group_order',refId:999001}));
  assert.equal(r.discountAmount,100); assert.equal(r.finalTotal,400); assert.equal(r.discountCode,'TESTD_MAX');
});
expect('max_uses exhausted on 2nd', ()=>{ try{tx(()=>applyDiscountTx({code:'TESTD_MAX',phone:'0994000011',subtotal:500,kind:'group_order',refId:999002}));assert.fail();}catch(e){assert.equal(e.code,'code_exhausted');} });
expect('release frees the use', ()=>{ releaseRedemption({kind:'group_order',refId:999001}); const r=tx(()=>applyDiscountTx({code:'TESTD_MAX',phone:'0994000012',subtotal:500,kind:'group_order',refId:999003})); assert(r.discountAmount===100); releaseRedemption({kind:'group_order',refId:999003}); });

const idPer = mk({code:'TESTD_PER', discount_type:'percent', discount_value:50, active:1, per_phone_limit:1});
expect('per_phone exhausted on same phone 2nd use', ()=>{
  tx(()=>applyDiscountTx({code:'TESTD_PER',phone:'0994000020',subtotal:1000,kind:'booking',refId:999010}));
  try{tx(()=>applyDiscountTx({code:'TESTD_PER',phone:'0994000020',subtotal:1000,kind:'booking',refId:999011}));assert.fail();}catch(e){assert.equal(e.code,'per_phone_exhausted');}
});
expect('different phone still ok', ()=>{ const r=tx(()=>applyDiscountTx({code:'TESTD_PER',phone:'0994000021',subtotal:1000,kind:'booking',refId:999012})); assert.equal(r.discountAmount,500); });
expect('empty code → applyDiscountTx returns null', ()=>{ assert.equal(tx(()=>applyDiscountTx({code:'',phone:'0994000099',subtotal:500,kind:'group_order',refId:999099})),null); });
console.log('[discount-service] D3 done');

import { listDiscountCodes, createDiscountCode, updateDiscountCode, deleteDiscountCode, getSetting, setSetting, getOneOnOnePrice } from '../src/services/discountService.js';

console.log('[discount-service] D4 start');
expect('create + list shows used_count 0', ()=>{ const c=createDiscountCode({code:'testd_new',discount_type:'percent',discount_value:15}); assert.equal(c.code,'TESTD_NEW'); const row=listDiscountCodes().find(x=>x.code==='TESTD_NEW'); assert.equal(row.used_count,0); });
expect('duplicate code → 409 code_exists', ()=>{ try{createDiscountCode({code:'TESTD_NEW',discount_type:'fixed',discount_value:50});assert.fail();}catch(e){assert.equal(e.code,'code_exists');} });
expect('percent value >100 → invalid_value', ()=>{ try{createDiscountCode({code:'TESTD_BAD',discount_type:'percent',discount_value:150});assert.fail();}catch(e){assert.equal(e.code,'invalid_value');} });
expect('update active toggle', ()=>{ const c=createDiscountCode({code:'testd_upd',discount_type:'fixed',discount_value:50}); const u=updateDiscountCode(c.id,{active:0}); assert.equal(u.active,0); });
expect('delete unused ok', ()=>{ const c=createDiscountCode({code:'testd_del',discount_type:'fixed',discount_value:50}); assert.deepEqual(deleteDiscountCode(c.id),{ok:true}); });
expect('delete used → has_redemptions', ()=>{ const c=createDiscountCode({code:'testd_used',discount_type:'fixed',discount_value:50}); tx(()=>applyDiscountTx({code:'TESTD_USED',phone:'0994000030',subtotal:500,kind:'group_order',refId:999030})); try{deleteDiscountCode(c.id);assert.fail();}catch(e){assert.equal(e.code,'has_redemptions');} releaseRedemption({kind:'group_order',refId:999030}); });
expect('settings default 1500', ()=>assert.equal(getOneOnOnePrice(),1500));
expect('settings set/get', ()=>{ setSetting('one_on_one_price','1800'); assert.equal(getOneOnOnePrice(),1800); setSetting('one_on_one_price','1500'); });
console.log('[discount-service] D4 done');

reset();
