import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { normalizeCode, computeDiscount, validateDiscount, quoteDiscount } from '../src/services/discountService.js';
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

// ── D5: validateDiscount 回傳 remainingUses（循環預約混合估價用）──
console.log('[discount-service] D5 start');
expect('remainingUses：取 max_uses 與 per_phone_limit 較小者', ()=>{
  const c=createDiscountCode({code:'testd_rem',discount_type:'percent',discount_value:10,max_uses:5,per_phone_limit:2});
  const v=validateDiscount({code:'TESTD_REM',phone:'0994000031',subtotal:1500});
  assert.equal(v.remainingUses,2);
});
expect('remainingUses：用掉一次後遞減', ()=>{
  tx(()=>applyDiscountTx({code:'TESTD_REM',phone:'0994000031',subtotal:1500,kind:'booking',refId:999031}));
  const v=validateDiscount({code:'TESTD_REM',phone:'0994000031',subtotal:1500});
  assert.equal(v.remainingUses,1);
  releaseRedemption({kind:'booking',refId:999031});
});
expect('remainingUses：無上限 → null', ()=>{
  createDiscountCode({code:'testd_rem2',discount_type:'fixed',discount_value:100});
  const v=validateDiscount({code:'TESTD_REM2',phone:'0994000032',subtotal:1500});
  assert.equal(v.remainingUses,null);
});
console.log('[discount-service] D5 done');

// ── D6: fixed_price（每堂固定價；qty = 堂數）──
console.log('[discount-service] D6 start');
expect('computeDiscount fixed_price 單堂：1500 → 1200', ()=>assert.deepEqual(computeDiscount('fixed_price',1200,1500),{discountAmount:300,finalTotal:1200}));
expect('computeDiscount fixed_price 兩堂：3000 → 2400', ()=>assert.deepEqual(computeDiscount('fixed_price',1200,3000,2),{discountAmount:600,finalTotal:2400}));
expect('computeDiscount fixed_price 不會變貴：X ≥ 原價 → 折 0', ()=>assert.deepEqual(computeDiscount('fixed_price',2000,1500),{discountAmount:0,finalTotal:1500}));
expect('computeDiscount fixed_price qty 非法（0/undefined/小數/負/字串）一律當 1', ()=>{
  for (const q of [0, undefined, 1.5, -2, '3']) assert.deepEqual(computeDiscount('fixed_price',1200,3000,q),{discountAmount:1800,finalTotal:1200}, `qty=${q}`);
});
expect('percent/fixed 不受 qty 影響', ()=>{
  assert.deepEqual(computeDiscount('percent',10,1050,5),{discountAmount:105,finalTotal:945});
  assert.deepEqual(computeDiscount('fixed',800,500,5),{discountAmount:500,finalTotal:0});
});
mk({code:'TESTD_FP', discount_type:'fixed_price', discount_value:1200, active:1});
expect('validateDiscount fixed_price 帶 qty=3：4500 → 3600', ()=>{ const v=validateDiscount({code:'testd_fp',phone:'0994000040',subtotal:4500,qty:3}); assert.equal(v.type,'fixed_price'); assert.equal(v.value,1200); assert.equal(v.discountAmount,900); assert.equal(v.finalTotal,3600); });
expect('validateDiscount fixed_price 不帶 qty → 當 1', ()=>{ const v=validateDiscount({code:'testd_fp',phone:'0994000040',subtotal:1500}); assert.equal(v.finalTotal,1200); });
expect('quoteDiscount fixed_price qty=10：15000 → 12000', ()=>assert.equal(quoteDiscount({code:'TESTD_FP',amount:15000,qty:10}).finalTotal,12000));
expect('applyDiscountTx fixed_price qty=2 記 redemption amount 600', ()=>{
  tx(()=>applyDiscountTx({code:'TESTD_FP',phone:'0994000041',subtotal:3000,kind:'group_order',refId:999041,qty:2}));
  const r=db.prepare("SELECT amount FROM discount_redemptions WHERE kind='group_order' AND ref_id=999041").get();
  assert.equal(r.amount,600);
  releaseRedemption({kind:'group_order',refId:999041});
});
expect('createDiscountCode fixed_price OK', ()=>{ const c=createDiscountCode({code:'testd_fp2',discount_type:'fixed_price',discount_value:990}); assert.equal(c.discount_type,'fixed_price'); assert.equal(c.discount_value,990); });
expect('createDiscountCode fixed_price 值 0 → invalid_value', ()=>{ try{createDiscountCode({code:'TESTD_FP0',discount_type:'fixed_price',discount_value:0});assert.fail('should throw');}catch(e){assert.equal(e.code,'invalid_value');} });
expect('createDiscountCode 型態 bogus → invalid_type', ()=>{ try{createDiscountCode({code:'TESTD_BOGUS',discount_type:'bogus',discount_value:10});assert.fail('should throw');}catch(e){assert.equal(e.code,'invalid_type');} });
expect('updateDiscountCode 改型態為 fixed_price', ()=>{ const c=createDiscountCode({code:'testd_fp3',discount_type:'percent',discount_value:10}); const u=updateDiscountCode(c.id,{discount_type:'fixed_price',discount_value:1000}); assert.equal(u.discount_type,'fixed_price'); assert.equal(u.discount_value,1000); });
console.log('[discount-service] D6 done');

reset();
