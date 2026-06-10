// gcal 整合遷移：新欄位 + settings seed + accessor 預設值
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { getBookingHourlyCapacity, getGcalCalendarId } from '../src/services/discountService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gcal-migration test] start');

const bCols = db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);
expect('bookings.gcal_event_id 存在', () => assert(bCols.includes('gcal_event_id')));
expect('bookings.customer_email 存在', () => assert(bCols.includes('customer_email')));
const nCols = db.prepare('PRAGMA table_info(notifications)').all().map(c=>c.name);
expect('notifications.recipient 存在', () => assert(nCols.includes('recipient')));
expect('settings: gcal_calendar_id seed 為空字串', () => {
  const r = db.prepare("SELECT value FROM app_settings WHERE key='gcal_calendar_id'").get();
  assert(r && r.value === '');
});
expect('settings: booking_hourly_capacity seed 為 3', () => {
  const r = db.prepare("SELECT value FROM app_settings WHERE key='booking_hourly_capacity'").get();
  assert(r && r.value === '3');
});
expect('getBookingHourlyCapacity() 預設 3', () => assert.equal(getBookingHourlyCapacity(), 3));
expect('getGcalCalendarId() 預設空字串', () => assert.equal(getGcalCalendarId(), ''));
console.log('[gcal-migration test] done');
