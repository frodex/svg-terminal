import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt);
const SCRYPT_KEYLEN = 64;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  linux_user TEXT,
  provider TEXT,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  can_approve_users INTEGER NOT NULL DEFAULT 0,
  can_approve_admins INTEGER NOT NULL DEFAULT 0,
  can_approve_sudo INTEGER NOT NULL DEFAULT 0,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  admin_pin_hash TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS provider_links (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL REFERENCES users(email),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_links_email ON provider_links(email);
`;

export class UserStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    try {
      this.db.exec('ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0');
    } catch (e) {
      // Column already exists — ignore
    }
    try {
      this.db.exec('ALTER TABLE users ADD COLUMN admin_pin_hash TEXT');
    } catch (e) {}

    // Restrict DB file permissions to owner-only (0600)
    try {
      chmodSync(dbPath, 0o600);
      // WAL and SHM files
      try { chmodSync(dbPath + '-wal', 0o600); } catch {}
      try { chmodSync(dbPath + '-shm', 0o600); } catch {}
    } catch {}
  }

  findByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  }

  findByLinuxUser(linuxUser) {
    return this.db.prepare('SELECT * FROM users WHERE linux_user = ?').get(linuxUser) || null;
  }

  findByProvider(provider, providerId) {
    const link = this.db.prepare(
      'SELECT email FROM provider_links WHERE provider = ? AND provider_id = ?'
    ).get(provider, providerId);
    if (!link) return null;
    return this.findByEmail(link.email);
  }

  createPendingUser({ email, displayName, provider, providerId }) {
    this.db.prepare(
      "INSERT OR IGNORE INTO users (email, display_name, provider, provider_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
    ).run(email, displayName, provider || null, providerId || null, new Date().toISOString());
    if (provider && providerId) {
      this.db.prepare(
        'INSERT OR IGNORE INTO provider_links (provider, provider_id, email, linked_at) VALUES (?, ?, ?, ?)'
      ).run(provider, providerId, email, new Date().toISOString());
    }
  }

  approveUser(email, approvedBy) {
    this.db.prepare("UPDATE users SET status = 'approved', approved_by = ? WHERE email = ?").run(approvedBy, email);
  }

  denyUser(email) {
    this.db.prepare("UPDATE users SET status = 'denied' WHERE email = ?").run(email);
  }

  listPending() {
    return this.db.prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at").all();
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY email').all();
  }

  preApprove(emails, approvedBy) {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO users (email, display_name, status, approved_by, created_at) VALUES (?, ?, 'approved', ?, ?)"
    );
    const now = new Date().toISOString();
    for (const email of emails) {
      stmt.run(email, email.split('@')[0], approvedBy, now);
    }
  }

  updateFlags(email, flags) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(flags)) {
      if (['can_approve_users', 'can_approve_admins', 'can_approve_sudo'].includes(key)) {
        sets.push(key + ' = ?');
        vals.push(val);
      }
    }
    if (sets.length === 0) return;
    vals.push(email);
    this.db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE email = ?').run(...vals);
  }

  setSuperadmin(email, value) {
    this.db.prepare('UPDATE users SET is_superadmin = ? WHERE email = ?').run(value ? 1 : 0, email);
  }

  setLinuxUser(email, linuxUser) {
    this.db.prepare('UPDATE users SET linux_user = ? WHERE email = ?').run(linuxUser, email);
  }

  updateLastLogin(email) {
    this.db.prepare('UPDATE users SET last_login = ? WHERE email = ?').run(new Date().toISOString(), email);
  }

  linkProvider(email, provider, providerId) {
    this.db.prepare(
      'INSERT OR REPLACE INTO provider_links (provider, provider_id, email, linked_at) VALUES (?, ?, ?, ?)'
    ).run(provider, providerId, email, new Date().toISOString());
  }

  getProviderLinks(email) {
    return this.db.prepare('SELECT * FROM provider_links WHERE email = ?').all(email);
  }

  unlinkProvider(provider, providerId) {
    this.db.prepare('DELETE FROM provider_links WHERE provider = ? AND provider_id = ?').run(provider, providerId);
  }

  /** Merge pendingEmail into primaryEmail: move provider links, delete pending row. */
  mergeUser(pendingEmail, primaryEmail) {
    this.db.prepare('UPDATE provider_links SET email = ? WHERE email = ?').run(primaryEmail, pendingEmail);
    this.db.prepare('DELETE FROM users WHERE email = ?').run(pendingEmail);
  }

  deactivateUser(email) {
    this.db.prepare("UPDATE users SET status = 'deactivated' WHERE email = ?").run(email);
    this.db.prepare('DELETE FROM provider_links WHERE email = ?').run(email);
  }

  reactivateUser(email) {
    this.db.prepare("UPDATE users SET status = 'pending' WHERE email = ?").run(email);
  }

  listDeactivated() {
    return this.db.prepare("SELECT * FROM users WHERE status = 'deactivated' ORDER BY email").all();
  }

  deleteUser(email) {
    this.db.prepare('DELETE FROM provider_links WHERE email = ?').run(email);
    this.db.prepare('DELETE FROM users WHERE email = ?').run(email);
  }

  async setAdminPin(email, pin) {
    const salt = randomBytes(16).toString('hex');
    const hash = await scryptAsync(pin, salt, SCRYPT_KEYLEN);
    const stored = salt + ':' + hash.toString('hex');
    this.db.prepare('UPDATE users SET admin_pin_hash = ? WHERE email = ?').run(stored, email);
  }

  async verifyAdminPin(email, pin) {
    const user = this.findByEmail(email);
    if (!user || !user.admin_pin_hash) return false;
    const [salt, hashHex] = user.admin_pin_hash.split(':');
    const hash = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(pin, salt, SCRYPT_KEYLEN);
    if (hash.length !== derived.length) return false;
    return timingSafeEqual(hash, derived);
  }

  close() {
    this.db.close();
  }
}
