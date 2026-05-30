import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate, editTemplate, getTemplate } from '../src/services/courseService.js';

function reset() { db.exec("DELETE FROM course_sessions; DELETE FROM course_templates WHERE name LIKE 'PriceTest%';"); }
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function dstr(days){const d=new Date();d.setDate(d.getDate()+days);const p=(n)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}

console.log('[course-price test] start');
reset();
const r = createTemplate({ name:'PriceTest A', min_capacity:1, max_capacity:5, day_of_week:1, start_time:'19:00', recurrence:'weekly', cycle_start_date:dstr(1), cycle_end_date:dstr(30), price_per_session: 800 });
expect('price stored on create', () => assert.equal(getTemplate(r.templateId).price_per_session, 800));
editTemplate(r.templateId, { name:'PriceTest A', min_capacity:1, max_capacity:5, day_of_week:1, start_time:'19:00', recurrence:'weekly', cycle_start_date:dstr(1), cycle_end_date:dstr(30), price_per_session: 950 });
expect('price updated on edit', () => assert.equal(getTemplate(r.templateId).price_per_session, 950));
expect('default price 0 when omitted', () => {
  const r2 = createTemplate({ name:'PriceTest B', min_capacity:1, max_capacity:5, day_of_week:2, start_time:'19:00', recurrence:'weekly', cycle_start_date:dstr(1), cycle_end_date:dstr(30) });
  assert.equal(getTemplate(r2.templateId).price_per_session, 0);
});
console.log('[course-price test] done');
