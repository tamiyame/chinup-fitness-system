// coaches.color：COACH_COLORS 色卡 + updateCoach 驗證(合法/非法/清除) + 週資料(getCoachWeek all 模式)帶 coach_color。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { updateCoach, getCoach, COACH_COLORS } = await import('../src/services/coachService.js');
const { getCoachWeek } = await import('../src/services/coachCalendarService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[coach-color test] start');

function cleanup() {
  db.exec(`
    DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cc-%');
    DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'cc-%');
    DELETE FROM users WHERE email LIKE 'cc-%';
  `);
}
cleanup(); // 開頭防呆：上次若中斷殘留

const pad = n => String(n).padStart(2, '0');
const c1u = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('cc教練A','cc-c1@x.com','coach')").run().lastInsertRowid);
const c1 = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'cc-A',1)").run(c1u).lastInsertRowid);
const c2u = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('cc教練B','cc-c2@x.com','coach')").run().lastInsertRowid);
const c2 = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'cc-B',1)").run(c2u).lastInsertRowid);
const m = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('cc客','cc-m@x.com','user','0970000001')").run().lastInsertRowid);

// ── 色卡常數 ──
expect('COACH_COLORS：24 色、皆為 #RRGGBB、無重複', () => {
  assert.equal(COACH_COLORS.length, 24);
  assert.equal(new Set(COACH_COLORS).size, 24);
  for (const c of COACH_COLORS) assert.ok(/^#[0-9A-F]{6}$/i.test(c), `bad hex: ${c}`);
});

// ── updateCoach：合法值 ──
expect('updateCoach：合法色寫入', () => {
  updateCoach(c1, { color: COACH_COLORS[0] });
  assert.equal(getCoach(c1).color, COACH_COLORS[0]);
});

expect('updateCoach：換另一合法色可覆蓋既有值', () => {
  updateCoach(c1, { color: COACH_COLORS[5] });
  assert.equal(getCoach(c1).color, COACH_COLORS[5]);
});

// ── updateCoach：非法值 ──
expect('updateCoach：非法值（不在色卡內）400 invalid_color，且不覆蓋既有值', () => {
  assert.throws(() => updateCoach(c1, { color: '#123456' }), /invalid_color/);
  assert.throws(() => updateCoach(c1, { color: 'red' }), /invalid_color/);
  assert.equal(getCoach(c1).color, COACH_COLORS[5]); // 未被非法值變更
});

// ── updateCoach：清除語意 ──
expect('updateCoach：null 清除為 NULL', () => {
  updateCoach(c1, { color: null });
  assert.equal(getCoach(c1).color, null);
});

expect("updateCoach：空字串 '' 清除為 NULL", () => {
  updateCoach(c1, { color: COACH_COLORS[2] });
  assert.equal(getCoach(c1).color, COACH_COLORS[2]);
  updateCoach(c1, { color: '' });
  assert.equal(getCoach(c1).color, null);
});

expect('updateCoach：不帶 color 欄位（undefined）不動既有值', () => {
  updateCoach(c1, { color: COACH_COLORS[3] });
  updateCoach(c1, { specialty: '測試專長' }); // 沒帶 color
  assert.equal(getCoach(c1).color, COACH_COLORS[3]);
  assert.equal(getCoach(c1).specialty, '測試專長');
});

// ── 週資料：coach_color（鎖 2036 年，避免與其他測試的相對日期衝突）──
const base = new Date('2036-06-15T00:00:00'); // 任一 2036 年日期，只用來算所在週的週一
const toMon = (base.getDay() === 0 ? -6 : 1 - base.getDay());
const mon = new Date(base.getFullYear(), base.getMonth(), base.getDate() + toMon);
const start = `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
const d1 = `${start}T09:00:00`, d2 = `${start}T10:00:00`;

updateCoach(c1, { color: COACH_COLORS[7] }); // c1 指定色；c2 全程未設色 → 維持 NULL
db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(c1, m, d1, `${start}T10:00:00`);
db.prepare("INSERT INTO bookings (coach_id,member_id,start_at,end_at,session_type) VALUES (?,?,?,?, '1on1')").run(c2, m, d2, `${start}T11:00:00`);

expect('getCoachWeek all 模式：bookings 帶 coach_color，本教練色值正確、未設色教練為 null', () => {
  const w = getCoachWeek({ start, all: true });
  const b1 = w.bookings.find(b => b.coach_id === c1);
  const b2 = w.bookings.find(b => b.coach_id === c2);
  assert.ok(b1);
  assert.ok(b2);
  assert.equal(b1.coach_color, COACH_COLORS[7]);
  assert.equal(b2.coach_color, null);
});

expect('getCoachWeek 單教練模式：仍帶 coach_color', () => {
  const w = getCoachWeek({ coachId: c1, start });
  assert.equal(w.all, false);
  assert.ok(w.bookings.length > 0);
  assert.equal(w.bookings[0].coach_color, COACH_COLORS[7]);
});

cleanup(); // 結尾清理
console.log('[coach-color test] done');
