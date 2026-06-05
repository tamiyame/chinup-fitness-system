import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { createCoach, setCoachActive } from '../src/services/coachService.js';
import { createTemplate, editTemplate, getTemplate, listTemplates } from '../src/services/courseService.js';
import { getPublicGroupCourses } from '../src/services/groupOrderService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

function reset() {
  db.exec(`
    DELETE FROM course_sessions WHERE template_id IN (SELECT id FROM course_templates WHERE name LIKE 'CoachTest%');
    DELETE FROM course_templates WHERE name LIKE 'CoachTest%';
    DELETE FROM coaches WHERE display_name LIKE 'CoachTest%';
    DELETE FROM users WHERE email LIKE 'coachtest-%';
  `);
}

console.log('[course-coach test] start');
reset();

// ── Task 1: 欄位存在 ─────────────────────────────────────────────
expect('course_templates has coach_id column', () => {
  const cols = db.prepare('PRAGMA table_info(course_templates)').all().map(c => c.name);
  assert(cols.includes('coach_id'));
});

// 建一位教練（user + coach）
const cu = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('CoachTest U','coachtest-u@x.com',?, 'coach')").run(hashPassword('x'));
const coach = createCoach({ userId: cu.lastInsertRowid, displayName: 'CoachTest 阿龍' });
setCoachActive(coach.id, true);

// ── Task 2: 寫入 coach_id + 曝露 coach_name ──────────────────────
const r = createTemplate({
  name: 'CoachTest 週一團課', min_capacity: 1, max_capacity: 6,
  day_of_week: 1, start_time: '19:00', recurrence: 'weekly',
  cycle_start_date: dstr(1), cycle_end_date: dstr(30),
  price_per_session: 600, coach_id: coach.id,
});
expect('coach_id stored on create', () => assert.equal(getTemplate(r.templateId).coach_id, coach.id));
expect('listTemplates exposes coach_name', () => {
  const row = listTemplates().find(t => t.id === r.templateId);
  assert.equal(row.coach_name, 'CoachTest 阿龍');
});
expect('getPublicGroupCourses exposes coach_name', () => {
  const c = getPublicGroupCourses().find(t => t.name === 'CoachTest 週一團課');
  assert(c, '應出現在公開清單（有未來場次）');
  assert.equal(c.coach_name, 'CoachTest 阿龍');
});
expect('editTemplate updates coach_id', () => {
  const cu2 = db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('CoachTest U2','coachtest-u2@x.com',?, 'coach')").run(hashPassword('x'));
  const coach2 = createCoach({ userId: cu2.lastInsertRowid, displayName: 'CoachTest 小美' });
  editTemplate(r.templateId, {
    name: 'CoachTest 週一團課', min_capacity: 1, max_capacity: 6,
    day_of_week: 1, start_time: '19:00', recurrence: 'weekly',
    cycle_start_date: dstr(1), cycle_end_date: dstr(30),
    price_per_session: 600, coach_id: coach2.id,
  });
  assert.equal(getTemplate(r.templateId).coach_id, coach2.id);
});
expect('null coach_id → coach_name null', () => {
  const r3 = createTemplate({
    name: 'CoachTest 無教練', min_capacity: 1, max_capacity: 6,
    day_of_week: 2, start_time: '19:00', recurrence: 'weekly',
    cycle_start_date: dstr(1), cycle_end_date: dstr(30),
  });
  const row = listTemplates().find(t => t.id === r3.templateId);
  assert.equal(row.coach_name, null);
});
expect('getPublicGroupCourses null coach → coach_name null', () => {
  const c = getPublicGroupCourses().find(t => t.name === 'CoachTest 無教練');
  assert(c, '無教練課程仍應出現在公開清單');
  assert.equal(c.coach_name, null);
});

console.log('[course-coach test] done');
