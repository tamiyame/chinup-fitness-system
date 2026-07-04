import cron from 'node-cron';
import { processDeadlines, processReminders } from './services/courseService.js';
import { processFailedNotifications } from './services/notifications.js';
import { runBackup } from './services/backupService.js';
import { expirePendingOrders } from './services/groupOrderService.js';
import { reconcile } from './services/gcalSync.js';
import { pullChanges } from './services/gcalPull.js';

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

  // 每 10 分鐘釋出逾時未付的 pending 訂單並遞補候補
  cron.schedule('*/10 * * * *', () => {
    try {
      const r = expirePendingOrders();
      if (r.expired) console.log('[scheduler] expired pending orders:', r.expired);
    } catch (e) {
      console.error('[scheduler] expire-orders error:', e);
    }
  });

  // 每 5 分鐘重試失敗的 LINE 通知
  cron.schedule('*/5 * * * *', async () => {
    try {
      await processFailedNotifications();
    } catch (e) {
      console.error('[cron] processFailedNotifications failed:', e);
    }
  });

  // 每 5 分鐘：Google 日曆 reconcile（補建/補刪；功能未啟用時內部直接 return）
  cron.schedule('*/5 * * * *', async () => {
    try {
      await reconcile();
    } catch (e) {
      console.error('[scheduler] gcal reconcile error:', e);
    }
  });

  // 每 1 分鐘：Google 日曆反向同步（拉回人為異動；功能未啟用時內部直接 return）
  cron.schedule('* * * * *', async () => {
    try {
      await pullChanges();
    } catch (e) {
      console.error('[scheduler] gcal pull error:', e);
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
