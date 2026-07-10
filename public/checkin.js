// 到場打卡頁：掃館內 QR 進入。身分沿用 chinup.token；按打卡時取 GPS，由後端驗證在館內＋班表窗口。
const token = localStorage.getItem('chinup.token');
if (!token) location.replace('/login.html?redirect=' + encodeURIComponent('/checkin'));

const $ = (id) => document.getElementById(id);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const STATUS_CHIP = {
  done: ['已打卡 ✓', 'done'],
  open: ['可打卡', 'open'],
  upcoming: ['尚未開放', ''],
  closed: ['已結束', ''],
  voided: ['已註銷', ''],
};
const ERR_TEXT = {
  not_at_gym: (d) => `你似乎不在館內${d?.distance_m != null ? `（距離約 ${d.distance_m} 公尺）` : ''}，請到館內再打卡。`,
  no_active_shift: () => '現在沒有可打卡的班表時段，請於時段開始前再試。',
  attendance_voided: () => '此時段紀錄已被註銷，請聯繫管理者補登。',
  checkin_not_configured: () => '打卡尚未設定完成，請通知管理者到後台「薪資計算」填寫館址座標。',
  missing_location: () => '未取得定位，請重試。',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    location.replace('/login.html?redirect=' + encodeURIComponent('/checkin'));
    throw new Error('unauthenticated');
  }
  if (!res.ok) { const e = new Error(data?.error || String(res.status)); e.data = data; throw e; }
  return data;
}

function msg(text, cls) { const el = $('ck-msg'); el.textContent = text; el.className = 'ck-msg ' + (cls || ''); }

function render(d) {
  // 顯示登入身分：QR 共用、身分靠各自手機的登入 token，打卡前先讓教練確認記在誰名下
  $('ck-coach-name').textContent = d.coachName || '';
  $('ck-coach').hidden = !d.coachName;
  const dt = new Date(d.date + 'T00:00:00');
  $('ck-date').textContent = `${d.date.replace(/-/g, '/')}（週${WEEK[dt.getDay()]}）`;
  const rows = d.slots.map((s) => {
    const [label, cls] = STATUS_CHIP[s.status] || [s.status, ''];
    return `<div class="ck-slot"><span>${s.startTime}–${s.endTime}（${s.hours} 小時）</span><span class="ck-chip ${cls}">${label}</span></div>`;
  }).concat(d.extras.map((x) =>
    `<div class="ck-slot"><span>${x.startTime}–${x.endTime}（${x.hours} 小時）</span><span class="ck-chip done">補登 ✓</span></div>`
  ));
  $('ck-slots').innerHTML = rows.join('') || '<div class="ck-slot"><span>今天沒有你的班表時段</span></div>';
  $('ck-period').textContent = `本期（${d.period}）已累計 ${d.periodHours} 小時`;
}

async function load() {
  try { render(await api('/api/coach/checkin/today')); }
  catch (e) {
    if (e.data?.error === 'coach_only') { $('ck-date').textContent = '此頁僅供教練使用'; $('ck-punch').disabled = true; }
    else msg('載入失敗：' + (e.data?.error || e.message), 'err');
  }
}

$('ck-punch').addEventListener('click', () => {
  const btn = $('ck-punch');
  btn.disabled = true;
  msg('取得定位中…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const r = await api('/api/coach/checkin', { method: 'POST', body: {
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } });
      const a = r.attendance;
      msg(`${r.already ? '本時段已打卡 ✓' : '已記錄'}：${a.work_date.replace(/-/g, '/')} ${a.start_time}–${a.end_time}（${a.hours} 小時）`, 'ok');
      load();
    } catch (e) {
      msg((ERR_TEXT[e.data?.error] || (() => '打卡失敗：' + (e.data?.error || e.message)))(e.data?.detail), 'err');
    } finally { btn.disabled = false; }
  }, (err) => {
    btn.disabled = false;
    msg(err.code === err.PERMISSION_DENIED
      ? '無法取得定位：請允許此網站使用「位置」權限後重試（iPhone：設定 > Safari > 位置；Android：網址列鎖頭 > 權限 > 位置）。'
      : '定位失敗，請確認手機定位服務已開啟後重試。', 'err');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
});

load();
