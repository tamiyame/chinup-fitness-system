import cron from 'node-cron';
import { processDeadlines, processReminders } from './services/courseService.js';
import { runBackup } from './services/backupService.js';

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

  // 每週日 03:00 (Asia/Taipei) 跑 SQLite VACUUM INTO 快照
  cron.schedule('0 3 * * 0', () => {
    try {
      const r = runBackup();
      if (r.ok) console.log('[scheduler] backup ok:', r.file, r.size, 'bytes');
      // 失敗時 backupService 內部已 console.error + 寫 .last-error.txt
    } catch (e) {
      console.error('[scheduler] backup throw:', e);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[scheduler] cron jobs registered');
}
