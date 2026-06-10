// 管理用：清空所有 LINE 綁定（resetAllLineBindings）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { resetAllLineBindings } from '../src/services/lineBindingService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
// 前次留下的 rlb-b（admin）會被遷移成 is_admin=1 並收到其他測試的管理者廣播通知（FK 無 cascade）→ 先刪通知。
// 另外 resetAllLineBindings 是「全域」操作：共用測試 DB 裡其他測試殘留的綁定（如 notifications-flow 的
// notif-test 使用者）會讓 cleared 計數失準 → 先把所有殘留綁定歸零，讓計數只反映本測試插入的 2 筆。
function reset(){
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'rlb-%');
    DELETE FROM users WHERE email LIKE 'rlb-%';
    UPDATE users SET line_user_id=NULL WHERE line_user_id IS NOT NULL;
  `);
}

console.log('[admin-reset-line-bindings test] start');
reset();

// 2 位已綁定 + 1 位綁定進行中（有碼未綁）+ 1 位無綁定
db.prepare("INSERT INTO users (name,email,role,line_user_id) VALUES ('RLB A','rlb-a@x.com','coach','Uaaa111')").run();
db.prepare("INSERT INTO users (name,email,role,line_user_id) VALUES ('RLB B','rlb-b@x.com','admin','Ubbb222')").run();
db.prepare("INSERT INTO users (name,email,role,line_bind_code,line_bind_expires_at) VALUES ('RLB C','rlb-c@x.com','user','123456','2099-01-01T00:00:00')").run();
db.prepare("INSERT INTO users (name,email,role) VALUES ('RLB D','rlb-d@x.com','user')").run();

const res = resetAllLineBindings();
expect('cleared = 已綁定(line_user_id 非空)人數 = 2', () => assert.equal(res.cleared, 2));
expect('全部 line_user_id / line_bind_code / line_bind_expires_at 皆清空', () => {
  const rows = db.prepare("SELECT line_user_id, line_bind_code, line_bind_expires_at FROM users WHERE email LIKE 'rlb-%'").all();
  for (const r of rows) {
    assert.equal(r.line_user_id, null);
    assert.equal(r.line_bind_code, null);
    assert.equal(r.line_bind_expires_at, null);
  }
});
expect('重複執行 → cleared = 0（idempotent）', () => assert.equal(resetAllLineBindings().cleared, 0));

console.log('[admin-reset-line-bindings test] done');
