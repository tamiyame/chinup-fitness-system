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

console.log('[course-coach test] done');
