// 「新增方案」共用選法：類型按鈕＋堂數選項（取自價目表）＋自訂。
// 後台會員彈窗（admin.js）與教練登錄彈窗（coach.js）共用。
// 本檔不匯入任何模組，匯入時不碰 document／window（node 測試直接匯入純邏輯）。

const TYPES = [['1on1', '一對一'], ['1on2', '一對二']];

const isPosInt = (s) => /^\d+$/.test(String(s).trim()) && Number(s) > 0;
const isNonNegInt = (s) => /^\d+$/.test(String(s).trim());
const money = (n) => Number(n).toLocaleString('zh-TW');

// 該類型的套裝選項，堂數小到大
export function optionsForType(plans, sessionType) {
  return (plans || [])
    .filter((p) => p.sessionType === sessionType)
    .map((p) => ({ totalSessions: p.totalSessions, unitPrice: p.unitPrice }))
    .sort((a, b) => a.totalSessions - b.totalSessions);
}

export function initialState(plans) {
  const has = optionsForType(plans, '1on1').length > 0;
  return { sessionType: '1on1', choice: has ? null : 'custom', customTotal: '', customUnit: '' };
}

// 切換類型：自訂維持（輸入保留）；否則清掉選擇，新類型沒有套裝就轉自訂
export function withType(state, plans, sessionType) {
  if (state.choice === 'custom') return { ...state, sessionType };
  const has = optionsForType(plans, sessionType).length > 0;
  return { ...state, sessionType, choice: has ? null : 'custom' };
}

// 價目表重取後：自訂維持；其餘一律清掉，該類型沒有套裝就轉自訂
export function withPlans(state, plans) {
  if (state.choice === 'custom') return state;
  const has = optionsForType(plans, state.sessionType).length > 0;
  return { ...state, choice: has ? null : 'custom' };
}

export function selectionOf(state, plans) {
  const { sessionType, choice } = state;
  if (typeof choice === 'number') {
    const opt = optionsForType(plans, sessionType).find((o) => o.totalSessions === choice);
    if (opt) return { ok: true, sessionType, totalSessions: opt.totalSessions, unitPrice: opt.unitPrice, fromPlan: true };
    return { ok: false, message: '請先選堂數' };
  }
  if (choice === 'custom') {
    if (!isPosInt(state.customTotal)) return { ok: false, message: '請填正確堂數' };
    const unitRaw = String(state.customUnit).trim();
    if (unitRaw !== '' && !isNonNegInt(unitRaw)) return { ok: false, message: '單價需為 0 以上整數' };
    return {
      ok: true,
      sessionType,
      totalSessions: Number(state.customTotal),
      unitPrice: unitRaw === '' ? null : Number(unitRaw),
      fromPlan: (plans || []).length > 0 ? false : undefined,
    };
  }
  return { ok: false, message: '請先選堂數' };
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

export function packageFields(sel) {
  const out = {
    sessionType: sel.sessionType,
    totalSessions: sel.totalSessions,
    amount: sel.unitPrice === null ? null : sel.unitPrice * sel.totalSessions,
  };
  if (sel.fromPlan !== undefined) out.fromPlan = sel.fromPlan;
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
  const radio = (label, onClick) => {
    const b = mk('button', 'pp-opt', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', onClick);
    return b;
  };

  container.textContent = '';
  const root = mk('div', 'pp');
  const typeGroup = mk('div', 'pp-row pp-types');
  typeGroup.setAttribute('role', 'radiogroup');
  typeGroup.setAttribute('aria-label', '類型');
  const typeBtns = TYPES.map(([val, label]) => {
    const b = radio(label, () => {
      state = withType(state, curPlans, val);
      sync(true);
      onChange();
    });
    b.dataset.type = val;
    typeGroup.appendChild(b);
    return b;
  });
  const sessGroup = mk('div', 'pp-row pp-sessions');
  sessGroup.setAttribute('role', 'radiogroup');
  sessGroup.setAttribute('aria-label', '堂數');
  const custom = mk('div', 'pp-custom');
  const totalIn = mk('input', 'form-input');
  totalIn.type = 'number';
  totalIn.setAttribute('inputmode', 'numeric');
  totalIn.placeholder = '堂數';
  const unitIn = mk('input', 'form-input');
  unitIn.type = 'number';
  unitIn.setAttribute('inputmode', 'numeric');
  unitIn.placeholder = '每堂單價（可空）';
  custom.append(totalIn, unitIn);
  const calc = mk('div', 'pp-calc');
  calc.setAttribute('aria-live', 'polite');

  root.append(mk('div', 'pp-label', '類型'), typeGroup, mk('div', 'pp-label', '堂數'), sessGroup, custom, calc);
  container.appendChild(root);

  let optBtns = [];
  let customBtn = null;

  // 堂數選項列：只在類型或價目表改變時重建，輸入框本身不動
  function buildSessions() {
    sessGroup.textContent = '';
    optBtns = optionsForType(curPlans, state.sessionType).map((o) => {
      const b = radio(`${o.totalSessions} 堂`, () => {
        state = { ...state, choice: o.totalSessions };
        sync(false);
        onChange();
      });
      b.dataset.sessions = String(o.totalSessions);
      sessGroup.appendChild(b);
      return b;
    });
    customBtn = radio('自訂', () => {
      state = { ...state, choice: 'custom' };
      sync(false);
      onChange();
      totalIn.focus();
    });
    customBtn.dataset.sessions = 'custom';
    sessGroup.appendChild(customBtn);
  }

  const setChecked = (el, on) => el.setAttribute('aria-checked', on ? 'true' : 'false');

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
    typeBtns.forEach((b) => setChecked(b, b.dataset.type === state.sessionType));
    optBtns.forEach((b) => setChecked(b, state.choice === Number(b.dataset.sessions)));
    setChecked(customBtn, state.choice === 'custom');
    custom.hidden = state.choice !== 'custom';
    paintCalc();
  }
  function sync(rebuild) {
    if (rebuild) buildSessions();
    paint();
  }

  totalIn.addEventListener('input', () => {
    state = { ...state, customTotal: totalIn.value };
    paint();
    onChange();
  });
  unitIn.addEventListener('input', () => {
    state = { ...state, customUnit: unitIn.value };
    paint();
    onChange();
  });

  sync(true);

  return {
    selection: () => selectionOf(state, curPlans),
    refresh: paintCalc,
    setPlans(next) {
      curPlans = next || [];
      state = withPlans(state, curPlans);
      sync(true);
    },
  };
}
