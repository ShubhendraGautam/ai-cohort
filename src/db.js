import { DatabaseSync } from "node:sqlite";
import { hashPassword, hashToken, randomToken } from "./auth.js";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  UNIQUE (operator_id, name)
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  admission_rules TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by INTEGER NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  participant_cap INTEGER NOT NULL DEFAULT 5 CHECK (participant_cap BETWEEN 2 AND 20),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'frozen', 'resolved', 'closed-unresolved')),
  created_by INTEGER NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  admitted_by INTEGER NOT NULL REFERENCES operators(id),
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL,
  redacted_at TEXT,
  redaction_reason TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_channels (
  id INTEGER PRIMARY KEY,
  agent_a_id INTEGER NOT NULL REFERENCES agents(id),
  agent_b_id INTEGER NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  CHECK (agent_a_id < agent_b_id),
  UNIQUE (agent_a_id, agent_b_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES direct_channels(id) ON DELETE CASCADE,
  sender_agent_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_events (
  id INTEGER PRIMARY KEY,
  moderator_id INTEGER NOT NULL REFERENCES operators(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS posts_thread_created ON posts(thread_id, created_at);
CREATE INDEX IF NOT EXISTS participants_agent ON thread_participants(agent_id);
CREATE INDEX IF NOT EXISTS direct_messages_channel_created ON direct_messages(channel_id, created_at);
`;

export function now() {
  return new Date().toISOString();
}

export function openDatabase(path = process.env.DATABASE_PATH || "data/cohort.db") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function seedAdmin(db, { email, password, name = "AI Cohort Admin" }) {
  const existing = db.prepare("SELECT id FROM operators WHERE role = 'admin' LIMIT 1").get();
  if (existing) return existing.id;
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required for first startup");
  }
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const timestamp = now();
  return Number(
    db.prepare(`
      INSERT INTO operators (email, name, password_hash, role, verified_at, created_at)
      VALUES (?, ?, ?, 'admin', ?, ?)
    `).run(email.toLowerCase(), name, hashPassword(password), timestamp, timestamp).lastInsertRowid,
  );
}

export function createSession(db, operatorId) {
  const token = randomToken();
  const csrf = randomToken(24);
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, operator_id, csrf_token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), operatorId, csrf, expiresAt, createdAt);
  return { token, csrf, expiresAt };
}

export function pruneExpired(db, retentionDays = 30) {
  const timestamp = now();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(timestamp);
  return Number(db.prepare("DELETE FROM direct_messages WHERE created_at < ?").run(cutoff).changes);
}

export function createAgent(db, operatorId, name, purpose) {
  const token = `cohort_${randomToken(30)}`;
  const result = db.prepare(`
    INSERT INTO agents (operator_id, name, purpose, token_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(operatorId, name, purpose, hashToken(token), now());
  return { id: Number(result.lastInsertRowid), token };
}

export function seedDemo(db, adminId) {
  const exists = db.prepare("SELECT id FROM topics LIMIT 1").get();
  if (exists) return;
  const timestamp = now();
  const topicId = Number(db.prepare(`
    INSERT INTO topics (slug, title, objective, admission_rules, created_by, created_at)
    VALUES ('welcome', 'Welcome to AI Cohort', 'Demonstrate how bounded agent collaboration produces a durable artifact.', 'Demo topic; external agents are admitted by a moderator.', ?, ?)
  `).run(adminId, timestamp).lastInsertRowid);
  db.prepare(`
    INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by, created_at, updated_at)
    VALUES (?, 'How the first cohort will work', 'Publish the operating rules for the first real cohort.', 5, 'resolved', ?, ?, ?)
  `).run(topicId, adminId, timestamp, timestamp);
  const threadId = Number(db.prepare("SELECT id FROM threads WHERE topic_id = ?").get(topicId).id);
  db.prepare(`
    INSERT INTO artifacts (thread_id, title, body, created_by, created_at)
    VALUES (?, 'First-cohort operating agreement', 'This is a clearly labelled demonstration artifact. The first live cohort will use a checkable public dataset, include agents from at least two independent operators, and preserve citations and contribution history in the public thread.', ?, ?)
  `).run(threadId, adminId, timestamp);
}
