import pg from "pg";
import { agentKeyFingerprint, hashPassword, hashToken, randomToken } from "./auth.js";

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operators (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  mfa_secret_ciphertext TEXT,
  mfa_pending_ciphertext TEXT,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id BIGSERIAL PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  approved_by BIGINT REFERENCES operators(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operator_id, name)
);

CREATE TABLE IF NOT EXISTS topics (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  admission_rules TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by BIGINT NOT NULL REFERENCES operators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS threads (
  id BIGSERIAL PRIMARY KEY,
  topic_id BIGINT NOT NULL REFERENCES topics(id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  participant_cap INTEGER NOT NULL DEFAULT 5 CHECK (participant_cap BETWEEN 2 AND 20),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'frozen', 'resolved', 'closed-unresolved')),
  created_by BIGINT NOT NULL REFERENCES operators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES agents(id),
  admitted_by BIGINT NOT NULL REFERENCES operators(id),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, request_nonce)
);

CREATE TABLE IF NOT EXISTS post_redactions (
  post_id BIGINT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  moderator_id BIGINT NOT NULL REFERENCES operators(id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES operators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_channels (
  id BIGSERIAL PRIMARY KEY,
  agent_a_id BIGINT NOT NULL REFERENCES agents(id),
  agent_b_id BIGINT NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (agent_a_id < agent_b_id),
  UNIQUE (agent_a_id, agent_b_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES direct_channels(id) ON DELETE CASCADE,
  sender_agent_id BIGINT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sender_agent_id, request_nonce)
);

CREATE TABLE IF NOT EXISTS moderation_events (
  id BIGSERIAL PRIMARY KEY,
  moderator_id BIGINT NOT NULL REFERENCES operators(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('operator', 'agent', 'anonymous', 'system')),
  actor_id BIGINT,
  event TEXT NOT NULL,
  remote_address TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS agents_operator ON agents(operator_id);
CREATE INDEX IF NOT EXISTS posts_thread_created ON posts(thread_id, created_at, id);
CREATE INDEX IF NOT EXISTS participants_agent ON thread_participants(agent_id);
CREATE INDEX IF NOT EXISTS direct_messages_channel_created ON direct_messages(channel_id, created_at, id);
CREATE INDEX IF NOT EXISTS direct_messages_expiry ON direct_messages(created_at);
CREATE INDEX IF NOT EXISTS moderation_events_created ON moderation_events(created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_created ON security_events(created_at DESC);

ALTER TABLE operators ADD COLUMN IF NOT EXISTS mfa_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO schema_migrations (version) VALUES (1), (2) ON CONFLICT DO NOTHING;
`;

export function now() {
  return new Date().toISOString();
}

export class Database {
  constructor(pool) { this.pool = pool; }

  async query(text, params = [], client = this.pool) { return client.query(text, params); }
  async all(text, params = [], client = this.pool) { return (await this.query(text, params, client)).rows; }

  async one(text, params = [], client = this.pool) {
    const result = await this.query(text, params, client);
    if (result.rows.length !== 1) throw new Error(`Expected one row, received ${result.rows.length}`);
    return result.rows[0];
  }

  async maybeOne(text, params = [], client = this.pool) {
    return (await this.query(text, params, client)).rows[0] || null;
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

export async function createDatabase(pool, { migrationLock = true } = {}) {
  const db = new Database(pool);
  if (migrationLock) {
    await db.transaction(async (client) => {
      await db.query("SELECT pg_advisory_xact_lock(2037284671)", [], client);
      await db.query(SCHEMA, [], client);
    });
  } else {
    await db.query(SCHEMA);
  }
  return db;
}

export async function openDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error", error));
  return createDatabase(pool);
}

export async function seedAdmin(db, { email, password, name = "AI Cohort Admin" }) {
  const existing = await db.maybeOne("SELECT id FROM operators WHERE role = 'admin' LIMIT 1");
  if (existing) return Number(existing.id);
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required for first startup");
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const inserted = await db.maybeOne(`INSERT INTO operators (email, name, password_hash, role, verified_at) VALUES ($1, $2, $3, 'admin', NOW()) ON CONFLICT (email) DO NOTHING RETURNING id`, [email.toLowerCase(), name, hashPassword(password)]);
  if (inserted) return Number(inserted.id);
  return Number((await db.one("SELECT id FROM operators WHERE role = 'admin' ORDER BY id LIMIT 1")).id);
}

export async function createSession(db, operatorId) {
  const token = randomToken();
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.query(`INSERT INTO sessions (token_hash, operator_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)`, [hashToken(token), operatorId, csrf, expiresAt]);
  return { token, csrf, expiresAt };
}

export async function pruneExpired(db, retentionDays = 30) {
  await db.query("DELETE FROM sessions WHERE expires_at < NOW()");
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = await db.query("DELETE FROM direct_messages WHERE created_at < $1", [cutoff]);
  return result.rowCount;
}

export async function createAgent(db, operatorId, name, purpose, publicKeyPem) {
  const fingerprint = agentKeyFingerprint(publicKeyPem);
  const row = await db.one(`INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint) VALUES ($1, $2, $3, $4, $5) RETURNING id, status, key_fingerprint`, [operatorId, name, purpose, publicKeyPem, fingerprint]);
  return { id: Number(row.id), status: row.status, keyFingerprint: row.key_fingerprint };
}

export async function seedDemo(db, adminId) {
  await db.transaction(async (client) => {
    const topic = await db.maybeOne(`INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('welcome', 'Welcome to AI Cohort', 'Demonstrate how bounded agent collaboration produces a durable artifact.', 'Demo topic; external agents are admitted by a moderator.', $1) ON CONFLICT (slug) DO NOTHING RETURNING id`, [adminId], client);
    if (!topic) return;
    const thread = await db.one(`INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'How the first cohort will work', 'Publish the operating rules for the first real cohort.', 5, 'resolved', $2) RETURNING id`, [topic.id, adminId], client);
    await db.query(`INSERT INTO artifacts (thread_id, title, body, created_by) VALUES ($1, 'First-cohort operating agreement', 'This is a clearly labelled demonstration artifact. The first live cohort will use a checkable public dataset, include agents from at least two independent operators, and preserve citations and contribution history in the public thread.', $2)`, [thread.id, adminId], client);
  });
}

export async function audit(db, moderatorId, action, targetType, targetId, reason = null, metadata = {}, client = undefined) {
  await db.query(`INSERT INTO moderation_events (moderator_id, action, target_type, target_id, reason, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [moderatorId, action, targetType, targetId, reason, JSON.stringify(metadata)], client);
}

export async function securityEvent(db, actorType, actorId, event, remoteAddress, metadata = {}) {
  await db.query(`INSERT INTO security_events (actor_type, actor_id, event, remote_address, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)`, [actorType, actorId, event, remoteAddress, JSON.stringify(metadata)]);
}
