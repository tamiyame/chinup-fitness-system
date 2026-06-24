// API：reschedule/reassign 端點 + 守門；week all=1 管理者 vs 非管理者。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE=process.env.BASE||'http://localhost:3000';
async function req(method,path,{body,token}={}){const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;const r=await fetch(BASE+path,{method,headers:h,body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=t?JSON.parse(t):null;}catch{d=t;}return{status:r.status,data:d};}
function expect(label,fn){try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;}}
console.log('[booking-edit-api] start');
const clean=()=>db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'bea-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'bea-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'bea-%'); DELETE FROM users WHERE email LIKE 'bea-%'; DELETE FROM auth_sessions WHERE token LIKE 'bea-%'");
clean();
const login=await req('POST','/api/auth/login',{body:{email:'admin@chinup.local',password:'admin1234'}});
const token=login.data?.token;
expect('admin 登入',()=>assert.ok(token));
const coaches=await req('GET','/api/admin/coaches',{token});
const coachId=coaches.data.find(c=>c.is_active).id;
const m1=Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('BEA客1','bea-m1@x.com','0982000001','user')").run().lastInsertRowid);
const m2=Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('BEA客2','bea-m2@x.com','0982000002','user')").run().lastInsertRowid);
const pad=n=>String(n).padStart(2,'0'); const dd=new Date(Date.now()+14*86400000); const D=`${dd.getFullYear()}-${pad(dd.getMonth()+1)}-${pad(dd.getDate())}`;
const pkg=await req('POST','/api/coach/packages',{token,body:{memberId:m1,sessionType:'1on1',totalSessions:5,amount:7500}});
const reg=await req('POST','/api/coach/register',{token,body:{coachId,memberId:m1,packageId:pkg.data.id,startAt:`${D}T09:00:00`,recurrence:null}});
const bid=reg.data.created[0].id;
expect('登錄成功',()=>assert.equal(reg.status,201));

const rs=await req('PATCH',`/api/coach/bookings/${bid}/reschedule`,{token,body:{startAt:`${D}T16:00:00`}});
expect('改時段 → 200 + 新時段',()=>{ assert.equal(rs.status,200); assert.equal(db.prepare('SELECT start_at FROM bookings WHERE id=?').get(bid).start_at,`${D}T16:00:00`); });

const pkg2=await req('POST','/api/coach/packages',{token,body:{memberId:m2,sessionType:'1on1',totalSessions:3,amount:4500}});
const ra=await req('PATCH',`/api/coach/bookings/${bid}/reassign`,{token,body:{memberId:m2,packageId:pkg2.data.id}});
expect('改客人/方案 → 200 + 換 member/package',()=>{ assert.equal(ra.status,200); const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(bid); assert.equal(b.member_id,m2); assert.equal(b.package_id,pkg2.data.id); });

const wkAll=await req('GET',`/api/coach/week?all=1&start=${D}`,{token});
expect('管理者 all=1 → 回 all:true',()=>{ assert.equal(wkAll.status,200); assert.equal(wkAll.data.all,true); });

// 管理者取消（他教練的）方案預約 → 200 + 回補方案堂（編輯彈窗取消路徑）
const pkgC=await req('POST','/api/coach/packages',{token,body:{memberId:m1,sessionType:'1on1',totalSessions:4,amount:6000}});
const regC=await req('POST','/api/coach/register',{token,body:{coachId,memberId:m1,packageId:pkgC.data.id,startAt:`${D}T11:00:00`,recurrence:null}});
const cbid=regC.data.created[0].id;
const remBefore=db.prepare('SELECT remaining_sessions FROM customer_packages WHERE id=?').get(pkgC.data.id).remaining_sessions;
const del=await req('DELETE',`/api/bookings/${cbid}?coachId=${coachId}`,{token,body:{reason:'測試取消'}});
expect('管理者取消他教練方案預約 → 200 + 已取消 + 回補堂',()=>{
  assert.equal(del.status,200);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(cbid).status,'cancelled');
  assert.equal(db.prepare('SELECT remaining_sessions FROM customer_packages WHERE id=?').get(pkgC.data.id).remaining_sessions, remBefore+1);
});

// 非管理者教練 all=1 → 落回自己（all:false）；管理者 gate 不放行非管理者全覽
const ncoach=db.prepare("SELECT u.id AS uid FROM users u JOIN coaches c ON c.user_id=u.id WHERE u.role='coach' AND u.is_admin=0 AND c.is_active=1 LIMIT 1").get();
if (ncoach) {
  const ntok='bea-ctok-'+ncoach.uid;
  db.prepare("INSERT OR REPLACE INTO auth_sessions (token,user_id,expires_at) VALUES (?,?, '2099-01-01T00:00:00')").run(ntok,ncoach.uid);
  const wkNon=await req('GET',`/api/coach/week?all=1&start=${D}`,{token:ntok});
  expect('非管理者教練 all=1 → all:false（落回自己）',()=>{ assert.equal(wkNon.status,200); assert.equal(wkNon.data.all,false); });
  db.prepare("DELETE FROM auth_sessions WHERE token=?").run(ntok);
}

// role=user 連 requireCoach 都過不了 → 403 coach_only（非「all 落回自己」邏輯）
const utok='bea-token-'+m1;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token,user_id,expires_at) VALUES (?,?, '2099-01-01T00:00:00')").run(utok,m1);
const wkUser=await req('GET',`/api/coach/week?all=1&start=${D}`,{token:utok});
expect('role=user 取週端點 → 403 coach_only',()=>assert.equal(wkUser.status,403));
db.prepare("DELETE FROM auth_sessions WHERE token=?").run(utok);

const noAuth=await req('PATCH',`/api/coach/bookings/${bid}/reschedule`,{body:{startAt:`${D}T17:00:00`}});
expect('未登入改時段 → 401',()=>assert.equal(noAuth.status,401));
clean();
console.log('[booking-edit-api] done');
