// 駐場 shiftService：班表 CRUD/日期比對/打卡/補登/註銷/期別彙總。資料鎖 2032 年與 shs- 前綴。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/services/discountService.js');
const {
  hoursBetween, listShifts, getShift, createShift, updateShift, deleteShift, shiftsForDate,
} = await import('../src/services/shiftService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[shift-service test] start');

// ── FK-safe 清理（attendance → shifts → coaches → users）──
db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'shs-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'shs-%'));
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'shs-%');
  DELETE FROM users WHERE email LIKE 'shs-%';
  DELETE FROM app_settings WHERE key LIKE 'checkin_%';
`);
function mkCoach(tag) {
  const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES (?,?,'coach')").run(tag, `shs-${tag}@x.com`).lastInsertRowid);
  return Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, ?, 1)").run(uid, tag).lastInsertRowid);
}
const cA = mkCoach('A');

// ── 基本工具與 CRUD ──
expect('hoursBetween 09:00–11:00 → 2；08:00–09:30 → 1.5', () => {
  assert.equal(hoursBetween('09:00', '11:00'), 2);
  assert.equal(hoursBetween('08:00', '09:30'), 1.5);
});

const D = '2032-03-03';                                  // 測試基準日
const DOW = new Date(D + 'T00:00:00').getDay();          // 依執行環境推導，不硬編
const s1 = createShift({ coachId: cA, dayOfWeek: DOW, startTime: '09:00', endTime: '11:00', effectiveFrom: '2032-01-01' });
expect('createShift 回傳完整列', () => {
  assert.equal(s1.coach_id, cA); assert.equal(s1.start_time, '09:00'); assert.equal(s1.effective_to, null);
});
expect('createShift 驗證：dow 7 → invalid_day_of_week', () => {
  assert.throws(() => createShift({ coachId: cA, dayOfWeek: 7, startTime: '09:00', endTime: '10:00', effectiveFrom: '2032-01-01' }),
    (e) => e.code === 'invalid_day_of_week');
});
expect('createShift 驗證：end ≤ start → invalid_time_range', () => {
  assert.throws(() => createShift({ coachId: cA, dayOfWeek: DOW, startTime: '11:00', endTime: '09:00', effectiveFrom: '2032-01-01' }),
    (e) => e.code === 'invalid_time_range');
});
expect('createShift 驗證：effective_to < effective_from → invalid_effective_range', () => {
  assert.throws(() => createShift({ coachId: cA, dayOfWeek: DOW, startTime: '09:00', endTime: '10:00', effectiveFrom: '2032-05-01', effectiveTo: '2032-04-01' }),
    (e) => e.code === 'invalid_effective_range');
});

expect('shiftsForDate：生效區間內命中、區間外不命中', () => {
  assert.equal(shiftsForDate(cA, D).length, 1);
  const ended = createShift({ coachId: cA, dayOfWeek: DOW, startTime: '14:00', endTime: '15:00', effectiveFrom: '2032-01-01', effectiveTo: '2032-03-02' });
  const future = createShift({ coachId: cA, dayOfWeek: DOW, startTime: '16:00', endTime: '17:00', effectiveFrom: '2032-03-04' });
  assert.equal(shiftsForDate(cA, D).length, 1);          // ended/future 都不算
  assert.deepEqual(shiftsForDate(cA, '2032-03-10').map((s) => s.start_time), ['09:00', '16:00']);  // 下週三：future 生效
  deleteShift(ended.id); deleteShift(future.id);
});
expect('updateShift 局部更新 + effective_to 清空', () => {
  const u = updateShift(s1.id, { effectiveTo: '2032-12-31' });
  assert.equal(u.effective_to, '2032-12-31');
  assert.equal(updateShift(s1.id, { effectiveTo: null }).effective_to, null);
});
expect('deleteShift 不存在 → shift_not_found', () => {
  assert.throws(() => deleteShift(999999), (e) => e.code === 'shift_not_found');
});
expect('listShifts(coachId) 只回該教練', () => {
  assert.ok(listShifts(cA).every((s) => s.coach_id === cA));
  assert.ok(listShifts().length >= 1);
});

// ── 打卡核心 ──
const { checkIn, todayStatus, haversineMeters, getCheckinConfig } = await import('../src/services/shiftService.js');
const GYM = { lat: 25.0330, lng: 121.5654 };   // 台北101 當測試館址
const FAR = { lat: 25.0478, lng: 121.5170 };   // 台北車站 ≈ 4.9km

expect('haversineMeters：同點=0、101↔北車 4~6km', () => {
  assert.equal(haversineMeters(GYM.lat, GYM.lng, GYM.lat, GYM.lng), 0);
  const d = haversineMeters(GYM.lat, GYM.lng, FAR.lat, FAR.lng);
  assert.ok(d > 4000 && d < 6000, `d=${d}`);
});
expect('未設座標 → checkin_not_configured(503)', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T09:10:00` }),
    (e) => e.status === 503 && e.code === 'checkin_not_configured');
});
setSetting('checkin_lat', String(GYM.lat));
setSetting('checkin_lng', String(GYM.lng));
expect('getCheckinConfig 預設半徑150/窗口30', () => {
  const c = getCheckinConfig();
  assert.equal(c.radius, 150); assert.equal(c.windowBeforeMin, 30); assert.equal(c.configured, true);
});
expect('缺定位 → missing_location(400)', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: NaN, lng: undefined, now: `${D}T09:10:00` }), (e) => e.code === 'missing_location');
});
expect('距離超出 → not_at_gym(403) 且 detail 帶 distance_m', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: FAR.lat, lng: FAR.lng, now: `${D}T09:10:00` }),
    (e) => e.status === 403 && e.code === 'not_at_gym' && e.detail.distance_m > 4000);
});
expect('窗口邊界：08:29 擋、08:30 過（開始前30分）', () => {
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T08:29:00` }), (e) => e.code === 'no_active_shift');
  const r = checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T08:30:00` });
  assert.equal(r.already, false);
  assert.equal(r.attendance.work_date, D); assert.equal(r.attendance.start_time, '09:00');
  assert.equal(r.attendance.hours, 2); assert.equal(r.attendance.source, 'checkin');
  assert.equal(r.attendance.distance_m, 0);
});
expect('重複打卡 → already=true 冪等回同列', () => {
  const r2 = checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D}T09:30:00` });
  assert.equal(r2.already, true);
});
expect('窗口尾界：11:00 可打（另一日）、11:01 擋', () => {
  const D2 = '2032-03-10';   // 下一個相同 dow
  assert.throws(() => checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D2}T11:01:00` }), (e) => e.code === 'no_active_shift');
  assert.equal(checkIn({ coachId: cA, lat: GYM.lat, lng: GYM.lng, now: `${D2}T11:00:00` }).already, false);
});
expect('快照語意：改班表不影響既有出席', () => {
  updateShift(s1.id, { startTime: '10:00' });
  const row = db.prepare('SELECT * FROM shift_attendance WHERE coach_id=? AND work_date=?').get(cA, D);
  assert.equal(row.start_time, '09:00'); assert.equal(row.hours, 2);
  updateShift(s1.id, { startTime: '09:00' });   // 還原
});
expect('todayStatus：已打卡 done、無班表日空 slots', () => {
  const st = todayStatus(cA, `${D}T12:00:00`);
  assert.equal(st.date, D);
  assert.equal(st.slots.length, 1);
  assert.equal(st.slots[0].status, 'done');
  assert.equal(st.slots[0].shiftId, s1.id);
  assert.equal(todayStatus(cA, '2032-03-04T09:00:00').slots.length, 0);  // 隔天非該 dow
});
expect('todayStatus 時間狀態：upcoming/open/closed', () => {
  const D3 = '2032-03-17';
  assert.equal(todayStatus(cA, `${D3}T08:00:00`).slots[0].status, 'upcoming');
  assert.equal(todayStatus(cA, `${D3}T08:30:00`).slots[0].status, 'open');
  assert.equal(todayStatus(cA, `${D3}T11:01:00`).slots[0].status, 'closed');
});

console.log('[shift-service test] done');
