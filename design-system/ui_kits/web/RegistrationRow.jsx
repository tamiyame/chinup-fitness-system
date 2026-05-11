const REG_LABEL = { confirmed: '正取', waitlisted: '候補', cancelled: '已取消', rejected: '未開課' };
const SESSION_LABEL = { open: '開放報名', confirmed: '已成班', cancelled: '未開課', completed: '已結束' };

const RegistrationRow = ({ reg, onCancel }) => {
  const dt = new Date(reg.start_at);
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const time = `${dt.getFullYear()}/${m}/${d} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const canCancel = ['confirmed', 'waitlisted'].includes(reg.status) && reg.session_status === 'open';

  return (
    <article className="card">
      <div className="flex items-center gap-5">
        <div className="text-center px-4 py-2 rounded-lg" style={{ background: 'var(--brand-50)', minWidth: 72 }}>
          <div className="text-2xl font-bold" style={{ color: 'var(--brand-700)', lineHeight: 1 }}>{d}</div>
          <div className="text-xs mt-1" style={{ color: 'var(--brand-700)' }}>{dt.getFullYear()}/{m}</div>
        </div>
        <div className="flex-1">
          <h3 className="card-title">{reg.course_name}</h3>
          <div className="meta">
            <span className="meta-item"><span className="meta-icon">🕐</span> {time}</span>
          </div>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <span className={`badge badge-${reg.status}`}>{REG_LABEL[reg.status]}</span>
            <span className={`badge badge-${reg.session_status}`}>場次 · {SESSION_LABEL[reg.session_status]}</span>
            {reg.position ? <span className="subtle">候補第 {reg.position} 位</span> : null}
          </div>
        </div>
        {canCancel && <button className="btn btn-danger btn-sm" onClick={() => onCancel?.(reg.id)}>取消報名</button>}
      </div>
    </article>
  );
};
window.RegistrationRow = RegistrationRow;
