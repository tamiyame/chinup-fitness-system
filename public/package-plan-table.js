// 價目表編輯的純邏輯：不匯入任何模組、匯入時不碰 document / window。
// row：{ total: number|string, isNew: boolean, p1on1: string, p1on2: string }

const MSG_PRICE = '每堂單價要填 1–1,000,000 的整數';

// '' 或全空白 → null；'1,400'、' 1400 '、'１４００'、'１，４００' → 1400；其他 → NaN
export function parseAmount(text) {
  const s = String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
  if (s === '') return null;
  const t = s.replace(/[,，]/g, '');
  if (!/^\d+$/.test(t)) return NaN;
  return Number(t);
}

// 價格格底下的小字：留空 → 不提供；有效價格＋可用堂數 → 共 NT$…；其他（讀不懂）→ 空字串
export function priceNote(text, total) {
  const v = parseAmount(text);
  if (v === null) return '不提供';
  if (Number.isNaN(v) || v < 1 || v > 1000000) return '';
  const n = typeof total === 'number' ? total : parseAmount(total);
  if (!n || Number.isNaN(n)) return '';
  return `共 NT$${(v * n).toLocaleString('en-US')}`;
}

function fmt(n) { return Number(n).toLocaleString('en-US'); }

// plans → row[]：堂數小到大，價格帶千分位，沒有的組合是 ''
export function rowsFromPlans(plans) {
  const map = new Map();
  for (const p of plans || []) {
    if (!map.has(p.totalSessions)) map.set(p.totalSessions, { total: p.totalSessions, isNew: false, p1on1: '', p1on2: '' });
    map.get(p.totalSessions)[p.sessionType === '1on2' ? 'p1on2' : 'p1on1'] = fmt(p.unitPrice);
  }
  return [...map.values()].sort((a, b) => a.total - b.total);
}

// row[] → { ok: true, plans } | { ok: false, rowIndex, field, message }
export function plansFromRows(rows) {
  const seen = new Set();
  const plans = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const blankTotal = String(r.total ?? '').trim() === '';
    const a = parseAmount(r.p1on1);
    const b = parseAmount(r.p1on2);
    if (r.isNew && blankTotal && a === null && b === null) continue;
    if (r.isNew && blankTotal) return { ok: false, rowIndex: i, field: 'total', message: '請先填堂數' };
    const total = typeof r.total === 'number' ? r.total : parseAmount(r.total);
    if (total === null || !Number.isInteger(total) || total < 1 || total > 200) {
      return { ok: false, rowIndex: i, field: 'total', message: '堂數要填 1–200 的整數' };
    }
    if (seen.has(total)) return { ok: false, rowIndex: i, field: 'total', message: '這個堂數已經有了' };
    seen.add(total);
    for (const [field, v] of [['1on1', a], ['1on2', b]]) {
      if (v === null) continue;
      if (!Number.isInteger(v) || v < 1 || v > 1000000) return { ok: false, rowIndex: i, field, message: MSG_PRICE };
      plans.push({ sessionType: field, totalSessions: total, unitPrice: v });
    }
  }
  if (plans.length > 60) return { ok: false, rowIndex: -1, field: 'total', message: '最多 60 個組合' };
  plans.sort((x, y) => x.totalSessions - y.totalSessions || (x.sessionType === y.sessionType ? 0 : x.sessionType === '1on1' ? -1 : 1));
  return { ok: true, plans };
}
