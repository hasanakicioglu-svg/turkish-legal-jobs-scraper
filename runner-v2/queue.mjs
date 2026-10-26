import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LANES = ['kariyer', 'linkedin', 'legal-sources', 'ai'];
export class Queue {
  constructor(filename, {now = () => Date.now(), leaseMs = 300000, maxAttempts = 5} = {}) {
    fs.mkdirSync(path.dirname(filename), {recursive: true});
    this.db = new DatabaseSync(filename);
    this.now = now; this.leaseMs = leaseMs; this.maxAttempts = maxAttempts;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, lane TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        owner TEXT, lease_until INTEGER, payload TEXT NOT NULL, result TEXT,
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(day,lane));
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at INTEGER NOT NULL,
        kind TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(id, kind, detail = {}) {
    this.db.prepare('INSERT INTO events(run_id,at,kind,detail) VALUES (?,?,?,?)')
      .run(id, this.now(), kind, JSON.stringify(detail));
  }
  enqueue({day, lane, ledgerId}) {
    return this.enqueueBatch([{day,lane,ledgerId}])[0];
  }
  enqueueBatch(entries) {
    return this.transaction(() => entries.map(entry=>this.enqueueOne(entry)));
  }
  enqueueOne({day, lane, ledgerId}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day).toISOString().slice(0,10) !== day) throw Error('Invalid day');
    if (!LANES.includes(lane)) throw Error('Invalid lane');
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(ledgerId)) throw Error('Invalid ledger ID');
      const existing = this.db.prepare('SELECT * FROM runs WHERE day=? AND lane=?').get(day, lane);
      if (existing) {
        if (JSON.parse(existing.payload).ledgerId !== ledgerId) throw Error('Existing day/lane must resume its original ledger');
        return this.get(existing.id);
      }
      const id = createHash('sha256').update(`${day}:${lane}`).digest('hex').slice(0,24);
      const now = this.now();
      this.db.prepare('INSERT INTO runs(id,day,lane,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, day, lane, 'queued', JSON.stringify({ledgerId}), now, now);
      this.event(id, 'queued'); return this.get(id);
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) return null;
    return {...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null};
  }
  claim() {
    return this.transaction(() => {
      const now = this.now();
      const expired = this.db.prepare("SELECT * FROM runs WHERE status='running' AND lease_until<=?").all(now);
      for (const row of expired) {
        const status = row.attempts >= this.maxAttempts ? 'needs_attention' : 'retry_wait';
        this.db.prepare('UPDATE runs SET status=?,owner=NULL,lease_until=NULL,next_at=?,updated_at=?,error=? WHERE id=?')
          .run(status, now, now, 'Worker lease expired; resume saved ledger', row.id);
        this.event(row.id, 'lease_expired', {status});
      }
      if (this.db.prepare("SELECT id FROM runs WHERE status='running'").get()) return null;
      // The earliest unfinished day/lane blocks later lanes, including during backoff.
      // Enqueue all desired lanes before starting the worker when strict batch order is required.
      const row = this.db.prepare(`SELECT * FROM runs WHERE status!='completed'
        ORDER BY day, CASE lane WHEN 'kariyer' THEN 0 WHEN 'linkedin' THEN 1
        WHEN 'legal-sources' THEN 2 ELSE 3 END LIMIT 1`).get();
      if (!row || row.status === 'needs_attention' || row.next_at > now) return null;
      const owner = randomUUID();
      this.db.prepare("UPDATE runs SET status='running',attempts=attempts+1,owner=?,lease_until=?,updated_at=? WHERE id=?")
        .run(owner, now + this.leaseMs, now, row.id);
      this.event(row.id, 'claimed'); return this.get(row.id);
    });
  }
  heartbeat(id, owner) {
    return this.db.prepare("UPDATE runs SET lease_until=?,updated_at=? WHERE id=? AND owner=? AND status='running' AND lease_until>?")
      .run(this.now()+this.leaseMs, this.now(), id, owner, this.now()).changes === 1;
  }
  finish(id, owner, result) {
    return this.settle(id, owner, 'completed', result, null);
  }
  fail(id, owner, code, {retryable = true} = {}) {
    const row = this.get(id);
    if (!row) throw Error('Unknown run');
    const status = retryable && row.attempts < this.maxAttempts ? 'retry_wait' : 'needs_attention';
    return this.settle(id, owner, status, null, code,
      this.now() + Math.min(3600000, 30000 * 2 ** Math.max(0,row.attempts-1)));
  }
  settle(id, owner, status, result, error, nextAt=0) {
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE runs SET status=?,result=?,error=?,next_at=?,owner=NULL,lease_until=NULL,updated_at=?
        WHERE id=? AND owner=? AND status='running' AND lease_until>?`)
        .run(status, result ? JSON.stringify(result) : null, error, nextAt, this.now(), id, owner, this.now()).changes;
      if (!changed) throw Error('Lease lost; stale worker cannot commit');
      this.event(id, status, {error}); return this.get(id);
    });
  }
  retry(id) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || row.status !== 'needs_attention') throw Error('Run must need attention');
      this.db.prepare("UPDATE runs SET status='queued',attempts=0,next_at=0,error=NULL,updated_at=? WHERE id=?")
        .run(this.now(), id);
      this.event(id, 'operator_retry'); return this.get(id);
    });
  }
  close() { this.db.close(); }
}
