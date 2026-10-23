// 一對二同行客人：我的課表兩種身分、週曆／待核對／gcal／email 讀模型帶同行名。fresh DB、LINE_MOCK=1。
process.env.LINE_MOCK = '1';
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createBookingAnon, cancelBookingAnon, listPendingPaymentBookings, listCoachBookings } from '../src/services/bookingService.js';
import { getPublicSchedule } from '../src/services/groupOrderService.js';
import { getCoachWeek } from '../src/services/coachCalendarService.js';
import { buildEventBody } from '../src/services/gcalSync.js';
import { _buildConfirmationHtml } from '../src/services/emailService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function futureLocal(days, hh = 10) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(hh)}:00:00`; }
console.log('[booking-companion-schedule test] start');
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0989%' OR email LIKE 'bcs-%');
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0989%') OR member2_id IN (SELECT id FROM users WHERE phone LIKE '0989%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'bcs-%');
  DELETE FROM users WHERE phone LIKE '0989%' OR email LIKE 'bcs-%';
`);
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('教練甲','bcs-coach@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: '教練甲' });
setCoachActive(coach.id, true);
const startAt = futureLocal(7, 11);
const r = createBookingAnon({ coachId: coach.id, startAt, name: '王小明', phone: '0989000001', sessionType: '1on2', companion: { name: '陳小華', phone: '0989000002' }, email: 'bcs-mail@x.com' });

expect('主客人我的課表：列出該筆、is_companion=false、companion_name=陳小華', () => {
  const s = getPublicSchedule({ phone: '0989000001', name: '王小明' });
  const it = s.items.find((x) => x.kind === 'booking' && x.id === r.id);
  assert.ok(it); assert.equal(it.is_companion, false); assert.equal(it.companion_name, '陳小華'); assert.equal(it.can_cancel, true);
});
expect('同行我的課表：列出同一筆、is_companion=true、companion_name=王小明', () => {
  const s = getPublicSchedule({ phone: '0989000002', name: '陳小華' });
  const it = s.items.find((x) => x.kind === 'booking' && x.id === r.id);
  assert.ok(it); assert.equal(it.is_companion, true); assert.equal(it.companion_name, '王小明'); assert.equal(it.can_cancel, true);
  assert.equal(s.stats.one_upcoming, 1);
});
expect('週曆：booking 帶 member2_id／companion_name／companion_phone', () => {
  const day = startAt.slice(0, 10);
  const monday = (() => { const d = new Date(`${day}T00:00:00`); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; })();
  const w = getCoachWeek({ coachId: coach.id, start: monday });
  const b = w.bookings.find((x) => x.id === r.id);
  assert.ok(b); assert.equal(b.companion_name, '陳小華'); assert.equal(b.companion_phone, '0989000002'); assert.ok(b.member2_id);
});
expect('待核對匯款與教練預約列表帶 companion_name', () => {
  const p = listPendingPaymentBookings().find((x) => x.id === r.id);
  assert.ok(p); assert.equal(p.companion_name, '陳小華');
  const c = listCoachBookings(coach.id).find((x) => x.id === r.id);
  assert.ok(c); assert.equal(c.companion_name, '陳小華');
});
expect('gcal 事件：summary 含「王小明＋陳小華」、description 含同行行', () => {
  const ev = buildEventBody(r.id);
  assert.ok(ev.summary.includes('王小明＋陳小華'), ev.summary);
  assert.ok(ev.description.includes('同行：陳小華（0989000002）'), ev.description);
});
expect('email 確認信含「同行客人」列', () => {
  const html = _buildConfirmationHtml(r.id);
  assert.ok(html.includes('同行客人') && html.includes('陳小華'));
});
expect('無同行的 1on2：companion_name null、gcal summary 無「＋」', () => {
  const r2 = createBookingAnon({ coachId: coach.id, startAt: futureLocal(8, 11), name: '王小明', phone: '0989000001', sessionType: '1on2' });
  const s = getPublicSchedule({ phone: '0989000001', name: '王小明' });
  const it = s.items.find((x) => x.kind === 'booking' && x.id === r2.id);
  assert.equal(it.companion_name, null); assert.equal(it.is_companion, false);
  assert.ok(!buildEventBody(r2.id).summary.includes('＋'));
});
expect('同行取消後兩邊都不再列出', () => {
  cancelBookingAnon({ bookingId: r.id, phone: '0989000002', name: '陳小華' });
  const a = getPublicSchedule({ phone: '0989000001', name: '王小明' }).items.find((x) => x.kind === 'booking' && x.id === r.id);
  const b = getPublicSchedule({ phone: '0989000002', name: '陳小華' }).items.find((x) => x.kind === 'booking' && x.id === r.id);
  assert.equal(a, undefined); assert.equal(b, undefined);
});
console.log('[booking-companion-schedule test] done');
