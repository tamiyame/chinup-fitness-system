import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body,token}={}){const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[package-discount-api] start');
const clean=()=>db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pda-%'); DELETE FROM users WHERE email LIKE 'pda-%'; DELETE FROM discount_codes WHERE code LIKE 'PDA%'");
clean();
const login=await req('POST','/api/auth/login',{body:{email:'admin@chinup.local',password:'admin1234'}});
const token=login.data?.token; expect('admin 登入',()=>assert.ok(token));
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDAPCT','percent',20,1)").run();
db.prepare("INSERT INTO discount_codes (code,discount_type,discount_value,active) VALUES ('PDAOFF','percent',20,0)").run();
const m=Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('PDA客','pda-m@x.com','0992000001','user')").run().lastInsertRowid);
const codes=await req('GET','/api/coach/discount-codes',{token});
expect('GET discount-codes 回 active、不含停用',()=>{ assert.equal(codes.status,200); const cs=codes.data.map(c=>c.code); assert.ok(cs.includes('PDAPCT')&&!cs.includes('PDAOFF')); });
const noAuth=await req('GET','/api/coach/discount-codes',{});
expect('未登入 → 401',()=>assert.equal(noAuth.status,401));
const c=await req('POST','/api/coach/packages',{token,body:{memberId:m,sessionType:'1on1',totalSessions:10,amount:10000,discountCode:'PDAPCT'}});
expect('建立方案帶折扣碼 → amount 折後 8000 + discount_code',()=>{ assert.equal(c.status,201); assert.equal(c.data.amount,8000); assert.equal(c.data.discount_code,'PDAPCT'); });
clean();
console.log('[package-discount-api] done');
