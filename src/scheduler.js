import cron from 'node-cron';
import { processDeadlines, processReminders } from './services/courseService.js';

export function startScheduler() {
  // 每小時整點跑截止判定
  cron.schedule('0 * * * *', () => {
    try {
      const r = processDeadlines();
      if (r.length) console.log('[scheduler] deadlines processed:', r);
    } catch (e) {
      console.error('[scheduler] deadline error:', e);
    }
  });

  // 每天早上 9 點寄送上課提醒
  cron.schedule('0 9 * * *', () => {
    try {
      const r = processReminders();
      if (r.length) console.log('[scheduler] reminders sent:', r);
    } catch (e) {
      console.error('[scheduler] reminder error:', e);
    }
  });

  console.log('[scheduler] cron jobs registered');
}
