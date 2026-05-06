// Top nav with sticky blur + auth bar
const Nav = ({ active = 'courses', user = { name: '王小明', role: 'user' }, onNav, onLogout }) => {
  const links = [
    { id: 'courses', label: '課程', href: '#courses' },
    { id: 'my', label: '我的報名', href: '#my' },
    ...(user.role === 'admin' || user.role === 'owner' ? [{ id: 'admin', label: '管理後台', href: '#admin' }] : []),
  ];
  const roleBadge = {
    owner: { cls: 'badge-waitlisted', label: '擁有者' },
    admin: { cls: 'badge-confirmed', label: '管理者' },
    user:  { cls: 'badge-open',      label: '會員' },
  }[user.role] || { cls: 'badge-open', label: '會員' };

  return (
    <nav className="navbar sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <a href="#" className="brand-mark" onClick={(e) => { e.preventDefault(); onNav?.('courses'); }}>
            <span className="brand-dot"><img src="logo.png" alt="logo" /></span> CHINUP Performance
          </a>
          <div className="hidden md:flex items-center gap-6">
            {links.map(l => (
              <a key={l.id} href={l.href}
                 onClick={(e) => { e.preventDefault(); onNav?.(l.id); }}
                 className={`nav-link ${active === l.id ? 'active' : ''}`}>{l.label}</a>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`badge ${roleBadge.cls}`} style={{ fontSize: 10 }}>{roleBadge.label}</span>
            <span className="text-sm font-medium">{user.name}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>登出</button>
        </div>
      </div>
    </nav>
  );
};
window.Nav = Nav;
