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
console.log('[gym-slots test] done');
