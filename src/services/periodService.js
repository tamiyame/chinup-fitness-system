// 期課雙月期別自動續期：進最後一週把 auto_renew 範本延到下期末並補場次。冪等，每日 cron＋開機各跑一次。
import { db, tx, nowLocal } from '../db/connection.js';
import { expandTemplate } from './schedule.js';
import { notifyAdmins } from './notifications.js';
import { periodOf, periodLabel, targetEndFor } from './period.js';

// 選取條件：已發布、有開自動續期、結束日還沒到目標（本期末或下期末）
const selectDue = db.prepare(`
  SELECT * FROM course_templates
  WHERE status = 'published' AND auto_renew = 1 AND cycle_end_date < ?
  ORDER BY id ASC
`);
const extendTemplate = db.prepare('UPDATE course_templates SET cycle_end_date = ? WHERE id = ?');
// 與 courseService.insertSession 同欄位；UNIQUE(template_id, session_date) 讓重展開只補新場次
const insertSession = db.prepare(`
  INSERT OR IGNORE INTO course_sessions
    (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
  VALUES (?, ?, ?, ?, ?, 'open', ?)
`);

/**
 * 把該續的範本延長到 targetEndFor(today) 並補場次。
 * @returns {{ targetEnd: string, extended: Array<{ id: number, name: string, added: number }> }}
 */
export function rolloverTemplates(today = nowLocal().slice(0, 10)) {
  const targetEnd = targetEndFor(today);
  const extended = tx(() => {
    const out = [];
    for (const t of selectDue.all(targetEnd)) {
      extendTemplate.run(targetEnd, t.id);
      let added = 0;
      for (const s of expandTemplate({ ...t, cycle_end_date: targetEnd })) {
        const info = insertSession.run(t.id, s.session_date, s.start_at, s.end_at, s.registration_deadline, t.coach_id);
        if (info.changes > 0) added++;
      }
      out.push({ id: t.id, name: t.name, added });
    }
    return out;
  });
  if (extended.length) {
    // 交易提交後才發；added=0 的也列出方便對帳
    notifyAdmins({
      type: 'period_rollover_admin',
      vars: {
        period_label: periodLabel(periodOf(targetEnd)),
        summary: extended.map((e) => `${e.name} ${e.added} 場`).join('、'),
      },
    });
  }
  return { targetEnd, extended };
}
