import { api, toast, bootAuth } from './app.js';

const user = await bootAuth();
if (!user) throw new Error('__redirected_by_auth__');

function fmtExpiresAt(localStr) {
  // "2026-05-12T14:35:00" → "14:35"
  const m = /T(\d{2}:\d{2})/.exec(localStr || '');
  return m ? m[1] : '--';
}

async function loadState() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('state-unbound').style.display = 'none';
  document.getElementById('state-bound').style.display = 'none';
  try {
    const data = await api('/api/my/line/binding');
    document.getElementById('loading').style.display = 'none';

    if (data.bound) {
      document.getElementById('state-bound').style.display = 'block';
    } else {
      document.getElementById('state-unbound').style.display = 'block';
      document.getElementById('code-display').textContent = data.code;
      document.getElementById('expires-at').textContent = fmtExpiresAt(data.expires_at);
      if (data.official_account_id) {
        const url = `https://line.me/R/ti/p/${encodeURIComponent(data.official_account_id)}`;
        const a = document.getElementById('friend-link');
        a.href = url;
        a.textContent = url;
      } else {
        document.getElementById('friend-link').textContent = '(尚未設定 LINE_OFFICIAL_ACCOUNT_ID，請聯絡管理員)';
      }
    }
  } catch (e) {
    document.getElementById('loading').textContent = `載入失敗：${e.message}`;
  }
}

document.getElementById('copy-btn').addEventListener('click', async () => {
  const code = document.getElementById('code-display').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('已複製代碼', 'success');
  } catch {
    toast('複製失敗，請手動選取', 'error');
  }
});

document.getElementById('regen-btn').addEventListener('click', async () => {
  try {
    const data = await api('/api/my/line/regenerate', { method: 'POST' });
    document.getElementById('code-display').textContent = data.code;
    document.getElementById('expires-at').textContent = fmtExpiresAt(data.expires_at);
    toast('已產生新代碼', 'success');
  } catch (e) {
    toast(`產生失敗：${e.message}`, 'error');
  }
});

document.getElementById('unbind-btn').addEventListener('click', async () => {
  if (!confirm('確定解除 LINE 綁定？解除後將不再收到通知。')) return;
  try {
    await api('/api/my/line', { method: 'DELETE' });
    toast('已解除綁定', 'success');
    await loadState();
  } catch (e) {
    toast(`解除失敗：${e.message}`, 'error');
  }
});

await loadState();
document.body.style.visibility = 'visible';
