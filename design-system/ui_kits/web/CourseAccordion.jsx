const Chevron = () => (
  <svg className="day-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>
);

const CourseAccordion = ({ group, defaultOpen = false, myRegs = new Map(), onRegister }) => {
  const next = group.sessions[0];
  const nextDt = new Date(next.start_at);
  const nextLabel = `${String(nextDt.getMonth() + 1).padStart(2, '0')}/${String(nextDt.getDate()).padStart(2, '0')} 週${['日','一','二','三','四','五','六'][nextDt.getDay()]} ${next.start_at.slice(11, 16)}`;
  const anyOpen = group.sessions.some(s => s.confirmed_count < s.max_capacity);

  return (
    <details className="day-group" open={defaultOpen}>
      <summary>
        <div className="day-chip">{group.sessions.length}<span className="day-chip-unit">場</span></div>
        <div className="day-title">
          <h3>
            {group.name}{' '}
            {!anyOpen && <span className="badge badge-waitlisted" style={{ fontSize: 11 }}>全數額滿</span>}
          </h3>
          <p>{group.description}</p>
          <p className="course-meta">🗓 下次 {nextLabel}・⏱ {group.duration_minutes} 分鐘・👥 {group.min_capacity}–{group.max_capacity} 人</p>
        </div>
        <Chevron />
      </summary>
      <div className="day-group-content">
        {group.sessions.map(s => (
          <SessionCard key={s.id} session={s} myReg={myRegs.get(s.id)} onRegister={onRegister} />
        ))}
      </div>
    </details>
  );
};
window.CourseAccordion = CourseAccordion;
