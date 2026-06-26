// API：POST /api/public/my 回 packages（顯示到課全上完；投影 共/已上完/尚餘(=共-已上完)）。需 running server。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createPackage, deductOne } from '../src/services/packageService.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body}={}){const r=await fetch(BASE+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[my-schedule-packages-api] start');
const clean=()=>db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'mspa-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'mspa-%'); DELETE FROM users WHERE email LIKE 'mspa-%'");
clean();
const coachId=db.prepare('SELECT id FROM coaches ORDER BY id LIMIT 1').get().id;
const u=Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('方案客','mspa-m@x.com','user','0995000001')").run().lastInsertRowid);
const p=createPackage({ memberId:u, sessionType:'1on1', totalSessions:6, amount:9000 });
const mkB=(s,e)=>db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,status,session_type,package_id) VALUES (?,?,?,?,?,?,?)").run(coachId,u,s,e,'confirmed','1on1',p.id);
deductOne(p.id); mkB('2020-01-01T10:00:00','2020-01-01T11:00:00'); // 1 已上完
deductOne(p.id); mkB('2099-01-01T10:00:00','2099-01-01T11:00:00'); // 1 待上
const r=await req('POST','/api/public/my',{body:{phone:'0995000001',name:'方案客'}});
expect('回 packages：共6/已上完1/尚餘5、不含 amount/used_sessions',()=>{
  assert.equal(r.status,200);
  assert.ok(Array.isArray(r.data.packages) && r.data.packages.length===1);
  const pk=r.data.packages[0];
  assert.equal(pk.total_sessions,6);
  assert.equal(pk.completed_sessions,1);
  assert.equal(pk.remaining_sessions,5);
  assert.ok(!('amount' in pk) && !('used_sessions' in pk));
});
clean();
console.log('[my-schedule-packages-api] done');
