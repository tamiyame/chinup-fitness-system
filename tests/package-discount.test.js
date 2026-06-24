// 方案折扣：quoteDiscount 計算/守門；createPackage 套用折扣+記碼。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { quoteDiscount, listActiveDiscountCodes } = await import('../src/services/discountService.js');
const { createPackage } = await import('../src/services/packageService.js');
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[package-discount test] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pd-%'); DELETE FROM users WHERE email LIKE 'pd-%'; DELETE FROM discount_codes WHERE code LIKE 'PD%'");
clean();
const m=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('PD客','pd-m@x.com','user','0991000001')").run().lastInsertRowid);
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDPCT','percent',10,1)").run();   // 10% off
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDFIX','fixed',500,1)").run();    // -500
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active,max_uses) VALUES ('PDLIM','percent',50,1,0)").run(); // 用量上限 0
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDOFF','percent',10,0)").run();   // 停用
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active,valid_until) VALUES ('PDEXP','percent',10,1,'2000-01-01')").run(); // 過期

expect('quoteDiscount percent：10000 → 9000', () => { assert.equal(quoteDiscount({code:'PDPCT',amount:10000}).finalTotal, 9000); });
expect('quoteDiscount fixed：10000 → 9500', () => { assert.equal(quoteDiscount({code:'PDFIX',amount:10000}).finalTotal, 9500); });
expect('quoteDiscount 不受 max_uses 限制（PDLIM 仍可報價）', () => { assert.equal(quoteDiscount({code:'PDLIM',amount:10000}).finalTotal, 5000); });
expect('quoteDiscount 停用 → 409', () => assert.throws(()=>quoteDiscount({code:'PDOFF',amount:10000}),/code_inactive/));
expect('quoteDiscount 過期 → 409', () => assert.throws(()=>quoteDiscount({code:'PDEXP',amount:10000}),/code_expired/));
expect('quoteDiscount 空碼 → null', () => assert.equal(quoteDiscount({code:'',amount:10000}),null));
expect('listActiveDiscountCodes 含 active、不含停用/過期', () => {
  const codes=listActiveDiscountCodes().map(c=>c.code);
  assert.ok(codes.includes('PDPCT')&&codes.includes('PDFIX')&&codes.includes('PDLIM'));
  assert.ok(!codes.includes('PDOFF')&&!codes.includes('PDEXP'));
});
expect('createPackage percent 碼 → amount 折後 + discount_code 記入', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000,discountCode:'PDPCT'});
  assert.equal(p.amount,13500); assert.equal(p.discount_code,'PDPCT');
});
expect('createPackage fixed 碼 → 折抵', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000,discountCode:'PDFIX'});
  assert.equal(p.amount,14500); assert.equal(p.discount_code,'PDFIX');
});
expect('createPackage 無碼 → amount 原值、discount_code null', () => {
  const p=createPackage({memberId:m,sessionType:'1on1',totalSessions:10,amount:15000});
  assert.equal(p.amount,15000); assert.equal(p.discount_code,null);
});
expect('createPackage 停用碼 → 擋', () => assert.throws(()=>createPackage({memberId:m,sessionType:'1on1',totalSessions:5,amount:5000,discountCode:'PDOFF'}),/code_inactive/));
clean();
console.log('[package-discount test] done');
