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

reset();
console.log('[discount-service] D2 done');
