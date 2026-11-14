// 線上單堂補登：開機一次性補登既有「沒有方案的未取消預約」。
// 用獨立的暫存資料庫；快照一律寫到暫存資料夾，不碰真正的備份目錄。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
// 資料庫放在自己的暫存資料夾：預設的快照資料夾（資料庫旁的 backups/）也就跟著隔離，不受其他測試殘留影響。
const dbPath = join(mkdtempSync(join(tmpdir(), 'online-single-backfill-')), 'test.db');
process.env.DB_PATH = dbPath;
process.env.LINE_MOCK = '1'; process.env.GMAIL_MOCK = '1'; process.env.GCAL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const pkg = await import('../src/services/packageService.js');
const bk = await import('../src/services/bookingService.js');
const { backfillOnlineSingles, utcToLocal } = await import('../src/services/onlineSingleBackfill.js');
const { runNamedSnapshot, removeNamedSnapshot, listNamedSnapshots, listBackups, pruneOldBackups } = await import('../src/services/backupService.js');
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
const errorRow = () => db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_error'").get()?.value ?? null;
const backfillError = () => pkg.getPackagesSummary().backfillError;
const LOCAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const SNAP = 'pre-online-single';
/** 快照、刪快照、列快照都指向同一個暫存資料夾（不碰預設的快照資料夾）。 */
const snapIn = (dir) => ({
  snapshot: () => runNamedSnapshot(SNAP, dir),
  removeSnapshot: (f) => removeNamedSnapshot(f, SNAP, dir),
  listSnapshots: () => listNamedSnapshots(SNAP, dir),
});
/** 預期中的 console.error 不印出來（測試輸出保持乾淨）。 */
const quiet = (fn) => { const orig = console.error; console.error = () => {}; try { return fn(); } finally { console.error = orig; } };
/** 替某位會員建方案時強制失敗（模擬單一筆壞資料讓整批補登失敗）。 */
const failFor = (memberId, fn) => {
  db.exec(`CREATE TRIGGER bf_row_fail BEFORE INSERT ON customer_packages WHEN NEW.member_id = ${Number(memberId)} BEGIN SELECT RAISE(ABORT, 'forced row'); END`);
  try { return fn(); } finally { db.exec('DROP TRIGGER bf_row_fail'); }
};

expect('快照失敗 → 不補、不寫旗標；summary 看得到原因', () => {
  const before = [pkgCount(), noPkgCount()];
  assert.deepEqual(backfillOnlineSingles({ snapshot: () => ({ ok: false, error: 'x' }) }), { ran: false, reason: 'snapshot_failed' });
  assert.deepEqual([pkgCount(), noPkgCount(), ...clean()], [...before, null, null]);
  const e = backfillError();
  assert.deepEqual([e.reason, e.error ?? null, e.snapshotLeft ?? null], ['snapshot_failed', null, null]);
  assert.match(e.at, LOCAL_TS);
});
expect('快照函式丟例外 → 不往外丟、不補、不寫旗標；summary 看得到原因', () => {
  const before = [pkgCount(), noPkgCount()];
  const r = backfillOnlineSingles({ snapshot: () => { throw new Error('boom'); } });
  assert.deepEqual([r.ran, r.reason, r.error, pkgCount(), noPkgCount(), ...clean()], [false, 'error', 'boom', ...before, null, null]);
  assert.deepEqual([backfillError().reason, backfillError().error], ['error', 'boom']);
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
expect('某一筆寫入失敗 → 錯誤訊息帶預約 id、剛做的快照被刪掉、summary 看得到原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-'));
  const before = [pkgCount(), noPkgCount()];
  const r = failFor(m2, () => backfillOnlineSingles(snapIn(dir)));   // m2 的第一筆是 C（A、B 已先插入，要一起回滾）
  assert.deepEqual([r.ran, r.reason, 'snapshotLeft' in r], [false, 'error', false]);
  assert.ok(r.error.startsWith(`booking ${C}: `), r.error); assert.match(r.error, /forced row/);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual([pkgCount(), noPkgCount(), ...clean()], [...before, null, null]);
  const e = backfillError();
  assert.deepEqual([e.reason, e.error, e.snapshotLeft ?? null], ['error', r.error, null]);
  assert.match(e.at, LOCAL_TS);
});
expect('刪快照的函式丟例外 → 不往外丟、只回 ran:false 並帶 snapshotLeft；快照留著', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-'));
  const opts = { ...snapIn(dir), removeSnapshot: () => { throw new Error('rm boom'); } };
  const before = [pkgCount(), noPkgCount()];
  const r = failFor(m2, () => backfillOnlineSingles(opts));
  assert.deepEqual([r.ran, r.reason], [false, 'error']);
  assert.ok(r.error.startsWith(`booking ${C}: `), r.error);
  assert.match(r.snapshotLeft, /^pre-online-single-\d{8}-\d{6}\.db$/);
  assert.deepEqual(readdirSync(dir), [r.snapshotLeft]);
  assert.deepEqual([pkgCount(), noPkgCount(), ...clean()], [...before, null, null]);
  assert.deepEqual([backfillError().error, backfillError().snapshotLeft], [r.error, r.snapshotLeft]);
});
expect('快照資料夾已有兩份殘留 → 不做新快照、不補登，回報殘留檔名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-'));
  const left = ['pre-online-single-20261101-000000.db', 'pre-online-single-20261102-000000.db'];
  for (const f of left) writeFileSync(join(dir, f), 'x');
  let snaps = 0;
  const before = [pkgCount(), noPkgCount()];
  const r = backfillOnlineSingles({ ...snapIn(dir), snapshot: () => { snaps++; return runNamedSnapshot(SNAP, dir); } });
  assert.deepEqual(r, { ran: false, reason: 'snapshot_leftover', files: left });
  assert.deepEqual([snaps, readdirSync(dir).sort(), pkgCount(), noPkgCount(), ...clean()], [0, left, ...before, null, null]);
  assert.equal(backfillError().reason, 'snapshot_leftover');
});
expect('刪具名快照：檔名不合不刪、刪掉回 true、本來就不在也算成功、刪不掉回 false 不丟例外', () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-snap-'));
  const ok = 'pre-online-single-20261103-000000.db';
  const others = ['app-20261103-000000.db', 'pre-online-single-x.db'];
  for (const f of [ok, ...others]) writeFileSync(join(dir, f), 'x');
  for (const f of [...others, `../${ok}`, null]) assert.equal(removeNamedSnapshot(f, SNAP, dir), false, String(f));
  assert.deepEqual(listNamedSnapshots(SNAP, dir), [ok]);
  assert.equal(removeNamedSnapshot(ok, SNAP, dir), true);
  assert.equal(removeNamedSnapshot(ok, SNAP, dir), true);   // 已經不在（ENOENT）也算成功
  assert.deepEqual(readdirSync(dir).sort(), others);
  const asDir = 'pre-online-single-20261104-000000.db'; mkdirSync(join(dir, asDir));   // 刪不掉的情況：同名的是資料夾
  assert.equal(quiet(() => removeNamedSnapshot(asDir, SNAP, dir)), false);
  assert.equal(existsSync(join(dir, asDir)), true);
  assert.deepEqual(listNamedSnapshots(SNAP, join(dir, 'missing')), []);
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
expect('summary：沒有方案的未取消預約為 0、補登摘要帶出；成功後先前的失敗原因清掉', () => {
  const s = pkg.getPackagesSummary(); assert.deepEqual([s.confirmedWithoutPackage, s.backfill.created, s.backfillError, errorRow()], [0, 7, null, '']);
});
expect('再跑一次 → 已完成；旗標遺失重跑 → 建立 0 筆、不再做快照', () => {
  assert.deepEqual(backfillOnlineSingles({ snapshot }), { ran: false, reason: 'done' });
  assert.equal(errorRow(), '');   // 「已完成」不算失敗，不寫失敗原因
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
