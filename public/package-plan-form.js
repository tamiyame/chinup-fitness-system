// 後台「方案」頁籤的純邏輯：側欄表單解析、清單分組與摘要。
// 匯入時不碰 document／window（node 測試直接匯入）。
import { parseAmount, planTitle } from './package-plan-picker.js';

const TYPES = [['1on1', '一對一'], ['1on2', '一對二']];
const MAX_SESSIONS = 200;
const MAX_UNIT_PRICE = 1000000;
const MAX_NAME_LENGTH = 20;

const money = (n) => Number(n).toLocaleString('zh-TW');
const inRange = (v, max) => v !== null && Number.isInteger(v) && v >= 1 && v <= max;

// 側欄表單的初始值：新增傳 null，編輯傳那一筆套裝
export function formFromPlan(plan) {
  if (!plan) return { sessionType: '1on1', total: '', unit: '', name: '', isActive: true };
  return {
    sessionType: plan.sessionType,
    total: String(plan.totalSessions),
    unit: money(plan.unitPrice),
    name: plan.name || '',
    isActive: !!plan.isActive,
  };
}

// 表單 → { ok: true, plan } | { ok: false, field: 'total'|'unit'|'name', message }
export function planFromForm(form) {
  const total = parseAmount(form.total);
  if (!inRange(total, MAX_SESSIONS)) return { ok: false, field: 'total', message: '堂數要填 1–200 的整數' };
  const unit = parseAmount(form.unit);
  if (!inRange(unit, MAX_UNIT_PRICE)) return { ok: false, field: 'unit', message: '每堂單價要填 1–1,000,000 的整數' };
  const name = String(form.name ?? '').trim();
  if ([...name].length > MAX_NAME_LENGTH) return { ok: false, field: 'name', message: '名稱最多 20 個字' };
  return {
    ok: true,
    plan: { sessionType: form.sessionType, totalSessions: total, unitPrice: unit, name: name === '' ? null : name, isActive: !!form.isActive },
  };
}

// 側欄的試算：「10 堂 × NT$1,300 ＝ 總價 NT$13,000」；還沒填好回空字串
export function formCalcText(form) {
  const total = parseAmount(form.total);
  const unit = parseAmount(form.unit);
  if (!inRange(total, MAX_SESSIONS) || !inRange(unit, MAX_UNIT_PRICE)) return '';
  return `${total} 堂 × NT$${money(unit)} ＝ 總價 NT$${money(total * unit)}`;
}

export function summaryText(plans) {
  const list = plans || [];
  if (!list.length) return '';
  const active = list.filter((p) => p.isActive).length;
  return `共 ${list.length} 個・啟用中 ${active} 個`;
}

// 依類型分組（一對一在前），組內保持伺服器給的順序；沒有的類型不出現
export function groupPlans(plans) {
  return TYPES
    .map(([sessionType, label]) => ({ sessionType, label, plans: (plans || []).filter((p) => p.sessionType === sessionType) }))
    .filter((g) => g.plans.length > 0);
}

// 清單一列要顯示的字
export function planRowParts(p) {
  return {
    title: planTitle(p),
    name: p.name || null,
    status: p.isActive ? '啟用中' : '已停用',
    formula: `${p.totalSessions} 堂 × NT$${money(p.unitPrice)}`,
    unit: `NT$${money(p.unitPrice)}`,
    total: `NT$${money(p.unitPrice * p.totalSessions)}`,
    toggleLabel: p.isActive ? '停用' : '啟用',
  };
}

const ERROR_MESSAGES = {
  duplicate_plan: '已經有類型、堂數、單價、名稱都一樣的套裝',
  too_many_plans: '套裝最多 100 個，請先刪掉用不到的',
  plan_not_found: '這個套裝已經被刪除',
  invalid_total: '堂數要填 1–200 的整數',
  invalid_unit_price: '每堂單價要填 1–1,000,000 的整數',
  invalid_name: '名稱最多 20 個字',
};

// 伺服器錯誤碼 → 給人看的話；不認得的回 null（呼叫端自己顯示原訊息）
export function planErrorMessage(code) {
  return ERROR_MESSAGES[code] || null;
}
