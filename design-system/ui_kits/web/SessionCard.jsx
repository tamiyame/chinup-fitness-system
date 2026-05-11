const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

const SessionCard = ({ session, myReg, onRegister }) => {
  const dt = new Date(session.start_at);
  const day = String(dt.getDate()).padStart(2, '0');
  const monthLabel = `${dt.getFullYear()} / ${String(dt.getMonth() + 1).padStart(2, '0')}`;
  const dayLabel = `週${DOW_SHORT[dt.getDay()]}`;
  const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const pct = Math.min(100, Math.round((session.confirmed_count / session.max_capacity) * 100));
  const full = session.confirmed_count >= session.max_capacity;

  let statusChip;
  if (myReg) {
    statusChip = myReg.status === 'confirmed'
      ? <span className="badge badge-confirmed">已報名（正取）</span>
      : <span className="badge badge-waitlisted">候補第 {myReg.position} 位</span>;
  } else {
    statusChip = full
      ? <span className="badge badge-waitlisted">已額滿</span>
      : <span className="badge badge-open">開放報名</span>;
  }

  return (
    <article className="card">
      <div className="flex flex-col md:flex-row gap-5">
        <div className="flex md:flex-col items-center md:items-center md:justify-center md:min-w-[90px] md:border-r md:border-slate-100 md:pr-5">
          <div className="text-4xl font-bold leading-none" style={{ letterSpacing: '-0.03em' }}>{day}</div>
          <div className="ml-2 md:ml-0 md:mt-1 flex md:flex-col items-baseline md:items-center gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--brand-700)' }}>{monthLabel}</span>
            <span className="text-xs" style={{ color: 'var(--ink-mute)' }}>{dayLabel}</span>
          </div>
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="card-title">{session.name}</h3>
              <p className="card-desc">{session.description || ''}</p>
            </div>
            {statusChip}
          </div>
          <div className="meta">
            <span className="meta-item"><span className="meta-icon">🕐</span> {time}・{session.duration_minutes} 分鐘</span>
            <span className="meta-item"><span className="meta-icon">👥</span> {session.confirmed_count} / {session.max_capacity} 人（需 {session.min_capacity} 人成班）</span>
            {session.waitlist_count > 0 && (
              <span className="meta-item" style={{ color: '#a16207' }}>
                <span className="meta-icon">⏳</span> 候補 {session.waitlist_count} 位
              </span>
            )}
          </div>
          <div className="capacity-bar"><div className={`capacity-fill ${full ? 'full' : ''}`} style={{ width: `${pct}%` }} /></div>
          <div className="flex items-center justify-between mt-4">
            <span className="subtle">報名截止：{session.registration_deadline}</span>
            {myReg
              ? <button disabled className="btn btn-ghost">已加入</button>
              : <button className="btn btn-primary" onClick={() => onRegister?.(session.id)}>{full ? '進入候補' : '立即報名'}</button>}
          </div>
        </div>
      </div>
    </article>
  );
};
window.SessionCard = SessionCard;
