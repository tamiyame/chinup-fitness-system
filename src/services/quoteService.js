import { randomBytes } from 'node:crypto';
import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting } from './discountService.js';

const TAX_RATE = 0.05;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nstr = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };

/** 白名單驗證＋正規化＋金額重算（不信前端送來的 subtotal/tax/total/amount）。丟 ApiError(400, code)。 */
export function validateQuoteInput(b) {
  const customer_title = String(b?.customer_title ?? '').trim();
  if (!customer_title) throw new ApiError(400, 'missing_customer_title');
  const quote_date = String(b?.quote_date ?? '').trim();
  if (!DATE_RE.test(quote_date)) throw new ApiError(400, 'invalid_quote_date');
  const valid_until = String(b?.valid_until ?? '').trim();
  if (!DATE_RE.test(valid_until)) throw new ApiError(400, 'invalid_valid_until');
  if (valid_until < quote_date) throw new ApiError(400, 'valid_until_before_quote_date');
  const rawItems = Array.isArray(b?.items) ? b.items : [];
  if (!rawItems.length) throw new ApiError(400, 'missing_items');
  const items = rawItems.map((it, i) => {
    const name = String(it?.name ?? '').trim();
    if (!name) throw new ApiError(400, 'missing_item_name', { index: i });
    const qty = Number(it?.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'invalid_item_qty', { index: i });
    const unit_price = Number(it?.unit_price);
    if (!Number.isInteger(unit_price) || unit_price < 0) throw new ApiError(400, 'invalid_item_price', { index: i });
    return { name, spec: nstr(it?.spec), qty, unit: nstr(it?.unit), unit_price, amount: Math.round(qty * unit_price) };
  });
  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return {
    customer_title, customer_tax_id: nstr(b?.customer_tax_id),
    contact_name: nstr(b?.contact_name), contact_phone: nstr(b?.contact_phone),
    quote_date, valid_until,
    payment_terms: nstr(b?.payment_terms), delivery_terms: nstr(b?.delivery_terms), notes: nstr(b?.notes),
    items, subtotal, tax, total: subtotal + tax,
  };
}

/** 單號 CU<年>-<4位流水>，年度重計。零填流水使字串排序＝數值排序。
 *  呼叫端需在 tx() 內（node:sqlite 同步、tx 序列化寫入即防撞號）。 */
export function nextQuoteNoFor(year) {
  const last = db.prepare('SELECT quote_no FROM quotes WHERE quote_no LIKE ? ORDER BY quote_no DESC LIMIT 1')
    .get(`CU${year}-%`);
  const n = last ? Number(last.quote_no.slice(-4)) + 1 : 1;
  return `CU${year}-${String(n).padStart(4, '0')}`;
}

const insertQuoteStmt = db.prepare(`INSERT INTO quotes
  (quote_no, token, customer_title, customer_tax_id, contact_name, contact_phone,
   quote_date, valid_until, payment_terms, delivery_terms, notes, subtotal, tax, total)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insertItemStmt = db.prepare(`INSERT INTO quote_items
  (quote_id, position, name, spec, qty, unit, unit_price, amount) VALUES (?,?,?,?,?,?,?,?)`);
const getQuoteStmt = db.prepare('SELECT * FROM quotes WHERE id = ?');
const getItemsStmt = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY position ASC, id ASC');

function withItems(q) { return q ? { ...q, items: getItemsStmt.all(q.id) } : null; }

export function createQuote(body) {
  const v = validateQuoteInput(body);
  return tx(() => {
    const quote_no = nextQuoteNoFor(nowLocal().slice(0, 4));
    const token = randomBytes(16).toString('hex');
    const info = insertQuoteStmt.run(quote_no, token, v.customer_title, v.customer_tax_id,
      v.contact_name, v.contact_phone, v.quote_date, v.valid_until,
      v.payment_terms, v.delivery_terms, v.notes, v.subtotal, v.tax, v.total);
    const id = Number(info.lastInsertRowid);
    v.items.forEach((it, i) => insertItemStmt.run(id, i, it.name, it.spec, it.qty, it.unit, it.unit_price, it.amount));
    return withItems(getQuoteStmt.get(id));
  });
}

export function listQuotes() {
  return db.prepare('SELECT * FROM quotes ORDER BY created_at DESC, id DESC').all();
}

export function getQuoteAdmin(id) {
  const q = withItems(getQuoteStmt.get(id));
  if (!q) throw new ApiError(404, 'not_found');
  return q;
}
