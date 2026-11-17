// 「新增方案」共用選法：一個下拉選單列出啟用中的套裝，最後一項是自訂。
// 後台會員彈窗（admin.js）與教練登錄彈窗（coach.js）共用。
// 本檔不匯入任何模組，匯入時不碰 document／window（node 測試直接匯入純邏輯）。

const TYPES = [['1on1', '一對一'], ['1on2', '一對二']];
const TYPE_LABEL = Object.fromEntries(TYPES);
const MSG_PICK = '請先選擇套裝';

const money = (n) => Number(n).toLocaleString('zh-TW');

// '' 或全空白 → null；'1,400'、' 1400 '、'１，４００' → 1400；其他（小數、負號、文字）→ NaN
export function parseAmount(text) {
  const s = String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
  if (s === '') return null;
  const t = s.replace(/[,，]/g, '');
  if (!/^\d+$/.test(t)) return NaN;
  return Number(t);
}

// 「一對一 10 堂」
export function planTitle(p) {
  return `${TYPE_LABEL[p.sessionType] || p.sessionType} ${p.totalSessions} 堂`;
}

// 選單裡的一行：「一對一 10 堂・舊生價・每堂 NT$1,300」；沒有名稱就少中間那段
export function planOptionLabel(p) {
  return [planTitle(p), p.name || null, `每堂 NT$${money(p.unitPrice)}`].filter(Boolean).join('・');
}

// choice：null＝還沒選、數字＝套裝編號、'custom'＝自訂。sessionType 只有自訂時用得到。
export function initialState(plans) {
  return { choice: (plans || []).length ? null : 'custom', sessionType: '1on1', customTotal: '', customUnit: '' };
}

// 選單的值（字串）→ 選擇
export function withChoice(state, value) {
  if (value === 'custom') return { ...state, choice: 'custom' };
  return { ...state, choice: /^\d+$/.test(String(value)) ? Number(value) : null };
}

// 套裝清單重新讀取後：自訂維持（輸入保留）；選過的套裝一律清掉重選，清單空了就轉自訂
export function withPlans(state, plans) {
  if (state.choice === 'custom') return state;
  return { ...state, choice: (plans || []).length ? null : 'custom' };
}

export function selectionOf(state, plans) {
  const { choice } = state;
  if (typeof choice === 'number') {
    const p = (plans || []).find((x) => x.id === choice);
    if (!p) return { ok: false, message: MSG_PICK };
    return { ok: true, sessionType: p.sessionType, totalSessions: p.totalSessions, unitPrice: p.unitPrice, fromPlan: true, planId: p.id };
  }
  if (choice === 'custom') {
    const total = parseAmount(state.customTotal);
    if (total === null || Number.isNaN(total) || total < 1) return { ok: false, message: '請填正確堂數' };
    const unit = parseAmount(state.customUnit);
    if (Number.isNaN(unit)) return { ok: false, message: '單價需為 0 以上整數' };
    return {
      ok: true,
      sessionType: state.sessionType,
      totalSessions: total,
      unitPrice: unit,
      // 有套裝可選卻選自訂 → false；本來就沒有套裝 → 不帶（與改版前相同）
      fromPlan: (plans || []).length > 0 ? false : undefined,
    };
  }
  return { ok: false, message: MSG_PICK };
}

// 試算列的三段：左邊的算式（或說明文字）、右邊的總額、下方的折扣說明；沒選好回 null
export function calcPartsOf(state, plans, hasDiscount) {
  const sel = selectionOf(state, plans);
  if (!sel.ok) return null;
  if (sel.unitPrice === null) return { text: '未填單價 → 建立為「無單價」方案', total: null, note: null };
  return {
    text: `${sel.totalSessions} 堂 × NT$${money(sel.unitPrice)}`,
    total: `NT$${money(sel.unitPrice * sel.totalSessions)}`,
    note: hasDiscount ? '套用折扣碼後以折後總額入帳' : null,
  };
}

// 送給 POST /api/coach/packages 的欄位
export function packageFields(sel) {
  const out = {
    sessionType: sel.sessionType,
    totalSessions: sel.totalSessions,
    amount: sel.unitPrice === null ? null : sel.unitPrice * sel.totalSessions,
  };
  if (sel.fromPlan !== undefined) out.fromPlan = sel.fromPlan;
  if (sel.planId !== undefined) out.planId = sel.planId;
  return out;
}

// ---- 畫面 ----
export function mountPlanPicker(container, { plans, hasDiscount, onChange }) {
  let curPlans = plans || [];
  let state = initialState(curPlans);

  const mk = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const option = (value, text) => {
    const o = mk('option', '', text);
    o.value = value;
    return o;
  };
  const numberInput = (label) => {
    const el = mk('input', 'form-input');
    el.type = 'text';
    el.setAttribute('inputmode', 'numeric');
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('aria-label', label);
    el.placeholder = label;
    return el;
  };

  container.textContent = '';
  const root = mk('div', 'pp');
  const select = mk('select', 'form-select pp-select');
  select.setAttribute('aria-label', '選擇套裝方案');

  const custom = mk('div', 'pp-custom');
  const typeGroup = mk('div', 'pp-types');
  typeGroup.setAttribute('role', 'radiogroup');
  typeGroup.setAttribute('aria-label', '類型');
  const typeBtns = TYPES.map(([val, label]) => {
    const b = mk('button', 'pp-opt', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.type = val;
    b.addEventListener('click', () => {
      state = { ...state, sessionType: val };
      paint();
      onChange();
    });
    typeGroup.appendChild(b);
    return b;
  });
  const totalIn = numberInput('堂數');
  const unitIn = numberInput('每堂單價（可空）');
  custom.append(typeGroup, totalIn, unitIn);

  const calc = mk('div', 'pp-calc');
  calc.setAttribute('aria-live', 'polite');

  root.append(select, custom, calc);
  container.appendChild(root);

  // 選單內容：只在套裝清單改變時重建
  function buildOptions() {
    select.textContent = '';
    select.appendChild(option('', '請選擇套裝'));
    curPlans.forEach((p) => select.appendChild(option(String(p.id), planOptionLabel(p))));
    select.appendChild(option('custom', '自訂（自己輸入堂數與單價）'));
  }

  // 試算列：左算式、右總額（大字）、折扣說明另起一行；沒有內容時保持空的（:empty 會整列隱藏）
  function paintCalc() {
    const parts = calcPartsOf(state, curPlans, hasDiscount());
    calc.textContent = '';
    if (!parts) return;
    calc.appendChild(mk('span', 'pp-calc-text', parts.text));
    if (parts.total) {
      const tot = mk('span', 'pp-calc-total');
      tot.append(mk('span', 'pp-calc-total-label', '總額'), mk('span', 'pp-calc-amt', parts.total));
      calc.appendChild(tot);
    }
    if (parts.note) calc.appendChild(mk('span', 'pp-calc-note', parts.note));
  }

  function paint() {
    select.value = state.choice === null ? '' : String(state.choice);
    select.classList.toggle('pp-select-empty', state.choice === null);
    typeBtns.forEach((b) => b.setAttribute('aria-checked', b.dataset.type === state.sessionType ? 'true' : 'false'));
    custom.hidden = state.choice !== 'custom';
    paintCalc();
  }

  select.addEventListener('change', () => {
    state = withChoice(state, select.value);
    paint();
    onChange();
    if (state.choice === 'custom') totalIn.focus();
  });
  totalIn.addEventListener('input', () => {
    state = { ...state, customTotal: totalIn.value };
    paintCalc();
    onChange();
  });
  unitIn.addEventListener('input', () => {
    state = { ...state, customUnit: unitIn.value };
    paintCalc();
    onChange();
  });

  buildOptions();
  paint();

  return {
    selection: () => selectionOf(state, curPlans),
    refresh: paintCalc,
    setPlans(next) {
      curPlans = next || [];
      state = withPlans(state, curPlans);
      buildOptions();
      paint();
    },
  };
}
