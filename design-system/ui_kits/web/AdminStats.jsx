const AdminStats = ({ templates = 0, sessions = 0, regs = 0, waitlist = 0 }) => (
  <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
    <div className="card"><div className="subtle">課程範本</div><div className="text-3xl font-bold mt-1">{templates}</div></div>
    <div className="card"><div className="subtle">總場次</div><div className="text-3xl font-bold mt-1">{sessions}</div></div>
    <div className="card"><div className="subtle">報名總人次</div><div className="text-3xl font-bold mt-1">{regs}</div></div>
    <div className="card"><div className="subtle">候補人次</div><div className="text-3xl font-bold mt-1" style={{ color: '#a16207' }}>{waitlist}</div></div>
  </section>
);
window.AdminStats = AdminStats;
