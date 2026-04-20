// Single source of truth for schema DDL. Used by connection.js to auto-apply
// on startup (idempotent) and by migrate.js CLI for explicit runs.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  notification_preference TEXT NOT NULL DEFAULT 'email',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS course_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  min_capacity INTEGER NOT NULL,
  max_capacity INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  recurrence TEXT NOT NULL CHECK(recurrence IN ('weekly','monthly','bimonthly','quarterly','semiannual')),
  cycle_start_date TEXT NOT NULL,
  cycle_end_date TEXT NOT NULL,
  registration_deadline_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS course_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES course_templates(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  registration_deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','confirmed','cancelled','completed')),
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  waitlist_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(template_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_sessions_start ON course_sessions(start_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON course_sessions(status);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('confirmed','waitlisted','cancelled','rejected')),
  position INTEGER,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reg_session_status ON registrations(session_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES course_sessions(id),
  type TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
