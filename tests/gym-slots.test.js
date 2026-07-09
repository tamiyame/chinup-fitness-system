// 固定時段＋指派：schema/歸組 migration/slots service。資料鎖 2033 年與 gsl- 前綴。
import assert from 'node:assert/strict';
const { db, backfillGymSlots } = await import('../src/db/connection.js');
const { createShift } = await import('../src/services/shiftService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gym-slots test] start');

// ── FK-safe 清理（attendance → shifts → slots → coaches → users）──
db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gsl-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gsl-%'));
  DELETE FROM gym_slots WHERE effective_from LIKE '2033-%';   -- 只掃本測試年份，勿全域掃孤兒時段（無教練時段是合法狀態）
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gsl-%');
  DELETE FROM users WHERE email LIKE 'gsl-%';
`);
db.prepare("INSERT OR IGNORE INTO users (id, name, email, role) VALUES (1, 'Test', 'test@example.com', 'user')").run();

function mkCoach(tag) {
  const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES (?,?,'coach')").run(tag, `gsl-${tag}@x.com`).lastInsertRowid);
  return Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, ?, 1)").run(uid, tag).lastInsertRowid);
}
const cA = mkCoach('A');
const cB = mkCoach('B');

// ── schema ──
expect('gym_slots 表存在且欄位齊全', () => {
  const cols = db.prepare('PRAGMA table_info(gym_slots)').all().map((c) => c.name);
  for (const k of ['id','day_of_week','start_time','end_time','effective_from','effective_to','created_at']) assert.ok(cols.includes(k), k);
});
expect('coach_shifts.slot_id 欄位存在', () => {
  assert.ok(db.prepare('PRAGMA table_info(coach_shifts)').all().map((c) => c.name).includes('slot_id'));
});

// ── 歸組 migration ──
expect('backfill：同參數多教練列併一時段、不同參數各自成段、重跑 no-op', () => {
  // createShift 走舊路徑（slot_id NULL）→ 模擬升級前資料
  createShift({ coachId: cA, dayOfWeek: 3, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-01-01' });
  createShift({ coachId: cB, dayOfWeek: 3, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-01-01' });
  createShift({ coachId: cA, dayOfWeek: 5, startTime: '18:00', endTime: '20:00', effectiveFrom: '2033-01-01' });
  const created = backfillGymSlots();
  assert.equal(created, 2);                                    // 兩組 → 兩個時段
  const orphans = db.prepare("SELECT COUNT(*) AS c FROM coach_shifts WHERE slot_id IS NULL").get().c;
  assert.equal(orphans, 0);
  const wed = db.prepare("SELECT DISTINCT slot_id FROM coach_shifts WHERE coach_id IN (?, ?) AND day_of_week = 3").all(cA, cB);
  assert.equal(wed.length, 1);                                 // A、B 共用同一時段
  assert.equal(backfillGymSlots(), 0);                         // 冪等
});

// ── slots service ──
const { listSlots, getSlot, createSlot, updateSlot, deleteSlot, assignCoach, unassignCoach } =
  await import('../src/services/shiftService.js');
const { manualAttendance } = await import('../src/services/shiftService.js');

const s1 = createSlot({ dayOfWeek: 2, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-02-01' });
expect('createSlot 回傳完整列＋驗證重用', () => {
  assert.equal(s1.day_of_week, 2); assert.equal(s1.effective_to, null);
  assert.throws(() => createSlot({ dayOfWeek: 7, startTime: '09:00', endTime: '10:00', effectiveFrom: '2033-02-01' }),
    (e) => e.code === 'invalid_day_of_week');
  assert.throws(() => createSlot({ dayOfWeek: 2, startTime: '11:00', endTime: '09:00', effectiveFrom: '2033-02-01' }),
    (e) => e.code === 'invalid_time_range');
});
expect('assignCoach 展開列：複製時段參數＋掛 slot_id；重複 → 409', () => {
  const row = assignCoach(s1.id, cA);
  assert.equal(row.coach_id, cA); assert.equal(row.slot_id, s1.id);
  assert.equal(row.day_of_week, 2); assert.equal(row.start_time, '09:00'); assert.equal(row.effective_from, '2033-02-01');
  assert.throws(() => assignCoach(s1.id, cA), (e) => e.status === 409 && e.code === 'coach_already_in_slot');
  assert.throws(() => assignCoach(999999, cA), (e) => e.code === 'slot_not_found');
});
expect('listSlots 內嵌教練＋排序', () => {
  assignCoach(s1.id, cB);
  const list = listSlots();
  const mine = list.find((s) => s.id === s1.id);
  assert.deepEqual(mine.coaches.map((c) => c.displayName), ['A', 'B']);
  assert.ok('coachId' in mine.coaches[0] && 'shiftId' in mine.coaches[0]);
  const keys = list.map((s) => s.day_of_week * 10000 + Number(s.start_time.replace(':', '')));
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
});
expect('updateSlot 連動旗下教練列、歷史出席快照不變、不可改星期（無此參數）', () => {
  const shiftRow = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ? AND coach_id = ?').get(s1.id, cA);
  const att = manualAttendance({ coachId: cA, workDate: '2033-02-08', shiftId: shiftRow.id, createdBy: 1 });  // manual 補登不驗日期星期（既有行為）
  const u = updateSlot(s1.id, { startTime: '10:00', endTime: '12:00' });
  assert.equal(u.start_time, '10:00');
  const rows = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ?').all(s1.id);
  assert.ok(rows.every((r) => r.start_time === '10:00' && r.end_time === '12:00'));
  assert.equal(db.prepare('SELECT start_time FROM shift_attendance WHERE id = ?').get(att.id).start_time, '09:00');  // 快照
  assert.equal(updateSlot(s1.id, { effectiveTo: '2033-12-31' }).effective_to, '2033-12-31');
  assert.equal(updateSlot(s1.id, { effectiveTo: null }).effective_to, null);
  assert.throws(() => updateSlot(999999, { startTime: '08:00' }), (e) => e.code === 'slot_not_found');
});
expect('unassignCoach 刪列、出席鏈不斷（shift_id 變 NULL、快照仍在）', () => {
  unassignCoach(s1.id, cA);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM coach_shifts WHERE slot_id = ? AND coach_id = ?').get(s1.id, cA).c, 0);
  const att = db.prepare("SELECT * FROM shift_attendance WHERE coach_id = ? AND work_date = '2033-02-08'").get(cA);
  assert.equal(att.shift_id, null); assert.equal(att.hours, 2);   // ON DELETE SET NULL＋快照保帳
  assert.throws(() => unassignCoach(s1.id, cA), (e) => e.code === 'coach_not_in_slot');
});
expect('deleteSlot 連動刪旗下教練列', () => {
  const s2 = createSlot({ dayOfWeek: 6, startTime: '08:00', endTime: '10:00', effectiveFrom: '2033-02-01' });
  assignCoach(s2.id, cB);
  deleteSlot(s2.id);
  assert.equal(getSlot(s2.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM coach_shifts WHERE slot_id = ?').get(s2.id).c, 0);
  assert.throws(() => deleteSlot(s2.id), (e) => e.code === 'slot_not_found');
});

// ── 重打卡防護：移除→重加同時段不得雙倍計薪 ──
{
  const { checkIn, todayStatus } = await import('../src/services/shiftService.js');
  const { setSetting } = await import('../src/services/discountService.js');
  setSetting('checkin_lat', '25.0330'); setSetting('checkin_lng', '121.5654');
  const D = '2033-05-04';                       // 任選測試日
  const DOW = new Date(D + 'T00:00:00').getDay();
  const s9 = createSlot({ dayOfWeek: DOW, startTime: '09:00', endTime: '11:00', effectiveFrom: '2033-05-01' });
  assignCoach(s9.id, cB);
  expect('打卡→移除→重加→再打卡 = already:true 且僅一筆出席', () => {
    const r1 = checkIn({ coachId: cB, lat: 25.0330, lng: 121.5654, now: `${D}T09:10:00` });
    assert.equal(r1.already, false);
    unassignCoach(s9.id, cB);
    assignCoach(s9.id, cB);
    const r2 = checkIn({ coachId: cB, lat: 25.0330, lng: 121.5654, now: `${D}T09:20:00` });
    assert.equal(r2.already, true);
    assert.equal(r2.attendance.id, r1.attendance.id);
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM shift_attendance WHERE coach_id = ? AND work_date = ?').get(cB, D).c;
    assert.equal(cnt, 1);
    const st = todayStatus(cB, `${D}T09:30:00`);
    assert.equal(st.slots[0].status, 'done');   // 新 shift id 仍顯示已打卡
    assert.equal(st.extras.length, 0);          // 不重複顯示為班表外
  });
  db.exec("DELETE FROM app_settings WHERE key IN ('checkin_lat','checkin_lng')");
}

console.log('[gym-slots test] done');
