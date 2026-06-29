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

// 取消全部預約（循環群組）：建 3 筆同 group → cancel-group → 全取消 + 回補堂數
const pkgG=await req('POST','/api/coach/packages',{token,body:{memberId:m1,sessionType:'1on1',totalSessions:5,amount:7500}});
const pgid=pkgG.data.id;
db.prepare('UPDATE customer_packages SET remaining_sessions=2 WHERE id=?').run(pgid); // 模擬已登錄 3 堂
const insG=db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type,package_id,paid_at,recurring_group_id) VALUES (?,?,?,?, '1on1', ?, '2026-06-24T00:00:00', ?)");
const gids=[
  Number(insG.run(coachId,m1,`${D}T08:00:00`,`${D}T09:00:00`,pgid,88001).lastInsertRowid),
  Number(insG.run(coachId,m1,`${D}T13:00:00`,`${D}T14:00:00`,pgid,88001).lastInsertRowid),
  Number(insG.run(coachId,m1,`${D}T14:00:00`,`${D}T15:00:00`,pgid,88001).lastInsertRowid),
];
const cg=await req('POST',`/api/coach/bookings/${gids[0]}/cancel-group`,{token,body:{reason:'測試全取消'}});
expect('取消全部預約 → 200 + cancelled 含全部 + DB 取消 + 回補',()=>{
  assert.equal(cg.status,200);
  assert.deepEqual([...cg.data.cancelled].sort((a,b)=>a-b),[...gids].sort((a,b)=>a-b));
  for(const id of gids) assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(id).status,'cancelled');
  assert.equal(db.prepare('SELECT remaining_sessions FROM customer_packages WHERE id=?').get(pgid).remaining_sessions,5); // 2+3
});

// 非該筆教練的一般教練取消全部 → 403 forbidden
const ocu=Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('BEA他教練','bea-oc@x.com','coach',0)").run().lastInsertRowid);
db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'bea-other',1)").run(ocu);
const otok='bea-octok-'+ocu;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token,user_id,expires_at) VALUES (?,?, '2099-01-01T00:00:00')").run(otok,ocu);
const g403=Number(insG.run(coachId,m1,`${D}T15:30:00`,`${D}T16:30:00`,pgid,88002).lastInsertRowid);
const cgF=await req('POST',`/api/coach/bookings/${g403}/cancel-group`,{token:otok,body:{reason:'x'}});
expect('非該教練的一般教練取消全部 → 403 forbidden',()=>assert.equal(cgF.status,403));
db.prepare("DELETE FROM bookings WHERE id=?").run(g403);
db.prepare("DELETE FROM coaches WHERE display_name='bea-other'").run();
db.prepare("DELETE FROM auth_sessions WHERE token=?").run(otok);

clean();
console.log('[booking-edit-api] done');
