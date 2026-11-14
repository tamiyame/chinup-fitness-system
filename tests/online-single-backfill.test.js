// 線上單堂補登：開機一次性補登既有「沒有方案的未取消預約」。
// 用獨立的暫存資料庫；快照一律寫到暫存資料夾，不碰真正的備份目錄。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
const dbPath = join(tmpdir(), `online-single-backfill-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
process.env.LINE_MOCK = '1'; process.env.GMAIL_MOCK = '1'; process.env.GCAL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const pkg = await import('../src/services/packageService.js');
const bk = await import('../src/services/bookingService.js');
const { backfillOnlineSingles, utcToLocal } = await import('../src/services/onlineSingleBackfill.js');
const { runNamedSnapshot, listBackups, pruneOldBackups } = await import('../src/services/backupService.js');
const { computePayroll, defaultPeriod } = await import('../src/services/payrollService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[online-single-backfill test] start');

const pad = (n, w = 2) => String(n).padStart(w, '0');
let seq = 0;
const member = () => { seq++; return Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?,?,'user',?)").run(`補${seq}`, `bf-m${seq}@x.com`, `0977${pad(seq, 6)}`).lastInsertRowid); };
const coachUser = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('bf教練','bf-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'bf教練', 1)").run(coachUser).lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('bf管','bf-a@x.com','coach',1)").run().lastInsertRowid);
let fN = 0, pN = 0;
const hourAt = (base, n) => { const d = new Date(base + Math.floor(n / 10) * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(8 + (n % 10))}:00:00`; };
const slot = () => hourAt(Date.now() + 40 * 86400000, fN++);
const pastSlot = () => hourAt(Date.now() - 40 * 86400000, pN++);
const endOf = (s) => `${s.slice(0, 11)}${pad(Number(s.slice(11, 13)) + 1)}:00:00`;
const row = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
const pack = (bookingId) => db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(row(bookingId).package_id);

/** 直接寫入沒有方案的舊預約，created_at 明確指定。 */
const raw = ({ m, startAt = slot(), type = '1on1', original = type === '1on2' ? 2000 : 1500, discount = null, code = null,
  status = 'confirmed', paid = false, member2 = null, group = null, createdAt }) =>
  Number(db.prepare(`INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, discount_amount, discount_code,
      status, paid_at, member2_id, recurring_group_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(coachId, m, startAt, endOf(startAt), type, original, discount, code, status, paid ? '2026-03-01T12:00:00' : null, member2, group, createdAt).lastInsertRowid);

const [m1, m2, m3, m4, m5] = [member(), member(), member(), member(), member()];
const A = raw({ m: m1, startAt: pastSlot(), paid: true, createdAt: '2026-03-01 02:30:00' });
const B = raw({ m: m1, discount: 100, code: 'X', createdAt: '2026-03-02 02:30:00' });
const C = raw({ m: m2, startAt: pastSlot(), original: null, createdAt: '2026-03-03 02:30:00' });
const D = raw({ m: m2, type: '1on2', member2: m3, createdAt: '2026-03-04 02:30:00' });
const E = raw({ m: m3, status: 'cancelled', createdAt: '2026-03-05 02:30:00' });
const F = raw({ m: m4, createdAt: '2026-03-06 02:30:00' });
const G = raw({ m: m4, group: F, createdAt: '2026-03-06 02:30:00' });
const tenPkg = pkg.createPackage({ memberId: m5, sessionType: '1on1', totalSessions: 10, amount: 15000 });
const H = bk.createCoachRegister({ coachId, memberId: m5, packageId: tenPkg.id ?? tenPkg, startAt: slot(), actorId: admin }).created[0].id;
const I = raw({ m: m5, paid: true, createdAt: 'garbage' });

expect('時間換算', () => {
  const d = new Date('2026-03-01T02:30:00Z');
  assert.equal(utcToLocal('2026-03-01 02:30:00'), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
  assert.equal(utcToLocal('2026-03-01T10:30:00'), '2026-03-01T10:30:00');
  assert.match(utcToLocal('garbage'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.match(utcToLocal(null), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

const pkgCount = () => db.prepare('SELECT COUNT(*) AS c FROM customer_packages').get().c;
const noPkgCount = () => db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE package_id IS NOT NULL').get().c;
const flag = () => db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_done'").get()?.value ?? null;
const summaryRow = () => db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_summary'").get()?.value ?? null;
const clean = () => [flag(), summaryRow()];

expect('快照失敗 → 不補、不寫旗標', () => {
  const before = [pkgCount(), noPkgCount()];
  assert.deepEqual(backfillOnlineSingles({ snapshot: () => ({ ok: false, error: 'x' }) }), { ran: false, reason: 'snapshot_failed' });
  assert.deepEqual([pkgCount(), noPkgCount(), ...clean()], [...before, null, null]);
});
expect('快照函式丟例外 → 不往外丟、不補、不寫旗標', () => {
  const before = [pkgCount(), noPkgCount()];
  const r = backfillOnlineSingles({ snapshot: () => { throw new Error('boom'); } });
  assert.deepEqual([r.ran, r.reason, r.error, pkgCount(), noPkgCount(), ...clean()], [false, 'error', 'boom', ...before, null, null]);
});
expect('寫入中途失敗 → 交易整個回滾：沒有新方案、沒有掛上、沒有旗標與摘要', () => {
  const before = [pkgCount(), noPkgCount()];
  // 摘要與旗標是交易最後才寫；在寫旗標時強制失敗，此時所有方案都已插入，必須全部回滾
  db.exec("CREATE TRIGGER bf_fail BEFORE INSERT ON app_settings WHEN NEW.key = 'online_single_backfill_done' BEGIN SELECT RAISE(ABORT, 'forced'); END");
  try {
    const r = backfillOnlineSingles({ snapshot: () => ({ ok: true, file: 'x.db', size: 1 }) });
    assert.deepEqual([r.ran, r.reason], [false, 'error']);
    assert.match(r.error, /forced/);
  } finally { db.exec('DROP TRIGGER bf_fail'); }
  assert.deepEqual([pkgCount(), noPkgCount(), ...clean()], [...before, null, null]);
});

let calls = 0;
const snapshot = () => { calls++; return { ok: true, file: 'pre-online-single-test.db', size: 1 }; };
const periods = [...new Set([A, B, C, D, F, G, H, I].map((id) => defaultPeriod(row(id).start_at)))];
const payroll = () => periods.map((period) => computePayroll({ period }));
const rowsNoPkg = () => db.prepare('SELECT * FROM bookings ORDER BY id').all().map(({ package_id, ...rest }) => rest);
const before = { payroll: payroll(), rows: rowsNoPkg(), notes: db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c, tenRemaining: pack(H).remaining_sessions };
const r = backfillOnlineSingles({ snapshot });
expect('補 7 筆、4 位會員，回傳與摘要一致', () => {
  assert.deepEqual([r.ran, r.created, r.members, r.snapshot, calls], [true, 7, 4, 'pre-online-single-test.db', 1]);
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(flag(), '1');
  assert.deepEqual(JSON.parse(summaryRow()), { created: 7, members: 4, at: r.at, snapshot: 'pre-online-single-test.db' });
});
expect('每筆補登的方案欄位正確', () => {
  for (const [id, amount, type] of [[A, 1500, '1on1'], [B, 1400, '1on1'], [C, null, '1on1'], [D, 2000, '1on2'], [F, 1500, '1on1'], [G, 1500, '1on1'], [I, 1500, '1on1']]) {
    const b = row(id); const p = pack(id);
    assert.deepEqual([p.source, p.total_sessions, p.remaining_sessions, p.member_id, p.session_type, p.amount, p.created_by],
      ['online', 1, 0, b.member_id, type, amount, null], `booking ${id}`);
    // I 的時間是壞資料，只要求格式正確（退回當下時間，不能讓整批補登失敗）
    if (id === I) assert.match(p.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    else assert.equal(p.created_at, utcToLocal(b.created_at), `booking ${id}`);
  }
  assert.equal(pack(B).discount_code, 'X');
});
expect('已取消的不補；教練開立的方案不動；預約的其他欄位一律不變', () => {
  assert.equal(row(E).package_id, null);
  assert.deepEqual([pack(H).source, pack(H).remaining_sessions], ['staff', before.tenRemaining]);
  assert.deepEqual(rowsNoPkg(), before.rows);
});
expect('薪資各期輸出與補登前完全相同；沒有新增任何通知', () => {
  assert.deepEqual(payroll(), before.payroll);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c, before.notes);
});
expect('補登後教練登錄不被單堂方案卡住；之後留下的 1 堂排在原有方案之後', () => {
  assert.equal(pkg.getPackage(pack(H).id).use_first_id, null);
  bk.cancelBookingAdmin({ bookingId: I, actorId: admin });          // I 已付款 → 保留 1 堂
  assert.equal(pkg.getPackage(pack(I).id).use_first_id, pack(H).id);
});
expect('summary：沒有方案的未取消預約為 0、補登摘要帶出', () => {
  const s = pkg.getPackagesSummary(); assert.deepEqual([s.confirmedWithoutPackage, s.backfill.created], [0, 7]);
});
expect('再跑一次 → 已完成；旗標遺失重跑 → 建立 0 筆、不再做快照', () => {
  assert.deepEqual(backfillOnlineSingles({ snapshot }), { ran: false, reason: 'done' });
  db.prepare("DELETE FROM app_settings WHERE key = 'online_single_backfill_done'").run();
  const n = pkgCount(); const again = backfillOnlineSingles({ snapshot });
  assert.deepEqual([again.ran, again.created, again.members, again.snapshot, pkgCount(), calls], [true, 0, 0, null, n, 1]);
});
expect('快照檔不會被每週備份的輪替刪掉，也不在備份清單裡', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-')); const s = runNamedSnapshot('pre-online-single', dir);
  assert.equal(s.ok, true); assert.match(s.file, /^pre-online-single-\d{8}-\d{6}\.db$/);
  pruneOldBackups(dir, 0);
  assert.equal(existsSync(join(dir, s.file)), true); assert.equal(listBackups(dir).files.length, 0);
});
expect('快照寫不進去（目的地是檔案）→ ok:false、不丟例外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-')); const notDir = join(dir, 'file'); writeFileSync(notDir, 'x');
  const s = runNamedSnapshot('pre-online-single', notDir);
  assert.equal(s.ok, false); assert.ok(s.error);
});
