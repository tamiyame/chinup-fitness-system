// tx()：BEGIN IMMEDIATE 失敗之後，之後的 tx() 仍要真的開交易、失敗真的回滾。
// 用獨立的暫存資料庫；不用 sleep，靠「先手動開一個交易」讓 tx() 的 BEGIN IMMEDIATE 必定失敗。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `tx-begin-failure-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
const { db, tx } = await import('../src/db/connection.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[tx-begin-failure test] start');

db.exec('CREATE TABLE tx_probe (v INTEGER NOT NULL)');
const count = () => db.prepare('SELECT COUNT(*) AS c FROM tx_probe').get().c;
const insert = (v) => db.prepare('INSERT INTO tx_probe (v) VALUES (?)').run(v);

expect('已有交易時 tx() 的 BEGIN 失敗 → 往外丟、裡面的函式不執行', () => {
  let ran = false;
  db.exec('BEGIN');
  try {
    assert.throws(() => tx(() => { ran = true; insert(0); }), /transaction/);
  } finally { db.exec('ROLLBACK'); }
  assert.deepEqual([ran, count(), db.isTransaction], [false, 0, false]);
});
expect('BEGIN 失敗之後：tx() 裡丟錯 → 真的開了交易並回滾', () => {
  let inTx = null;
  assert.throws(() => tx(() => { inTx = db.isTransaction; insert(1); throw new Error('boom'); }), /boom/);
  assert.deepEqual([inTx, count(), db.isTransaction], [true, 0, false]);
});
expect('BEGIN 失敗之後：tx() 成功 → 真的提交', () => {
  let inTx = null;
  assert.equal(tx(() => { inTx = db.isTransaction; insert(2); return 'ok'; }), 'ok');
  assert.deepEqual([inTx, count(), db.isTransaction], [true, 1, false]);
});
expect('巢狀 tx() 照舊：內層不另開交易，外層丟錯時內層寫入一併回滾', () => {
  assert.throws(() => tx(() => { tx(() => insert(3)); throw new Error('outer'); }), /outer/);
  assert.equal(count(), 1);
  tx(() => { tx(() => insert(4)); });
  assert.deepEqual([count(), db.isTransaction], [2, false]);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[tx-begin-failure test] done');
