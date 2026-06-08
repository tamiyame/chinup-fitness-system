// 管理用：清空所有 LINE 綁定（resetAllLineBindings）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { resetAllLineBindings } from '../src/services/lineBindingService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
function reset(){ db.exec("DELETE FROM users WHERE email LIKE 'rlb-%'"); }

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
