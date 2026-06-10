// SA JWT 簽章正確性（本地 keypair 驗簽，不打網路）+ 金鑰解析（raw / base64）。
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { _buildJwt, _parseServiceAccountJson } from '../src/services/googleAuth.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[google-auth test] start');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'svc@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };

const jwt = _buildJwt(sa, 1750000000);
const [h, c, sig] = jwt.split('.');
expect('JWT 三段式', () => assert.equal(jwt.split('.').length, 3));
expect('header alg RS256', () => assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256'));
expect('claims iss/scope/aud/exp 正確', () => {
  const cl = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(cl.iss, sa.client_email);
  assert.equal(cl.scope, 'https://www.googleapis.com/auth/calendar');
  assert.equal(cl.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(cl.iat, 1750000000);
  assert.equal(cl.exp, 1750003600);
});
expect('RS256 簽章可用公鑰驗證', () => {
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')));
});
expect('金鑰解析：raw JSON', () => assert.equal(_parseServiceAccountJson('{"client_email":"a@b.c"}').client_email, 'a@b.c'));
expect('金鑰解析：base64', () => {
  const b64 = Buffer.from('{"client_email":"x@y.z"}').toString('base64');
  assert.equal(_parseServiceAccountJson(b64).client_email, 'x@y.z');
});
expect('金鑰解析：壞輸入 → null', () => assert.equal(_parseServiceAccountJson('not json'), null));
console.log('[google-auth test] done');
