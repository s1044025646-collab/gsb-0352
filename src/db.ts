import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'app.db');

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tournament (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'setup',      -- setup | frozen
      size INTEGER,                              -- 签表大小（二次幂），冻结时确定
      max_participants INTEGER NOT NULL DEFAULT 1024,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS participant (
      tournament_id INTEGER NOT NULL REFERENCES tournament(id),
      id TEXT NOT NULL,                          -- 稳定编号
      seed INTEGER NOT NULL,                     -- 种子序号（导入顺序即种子顺序）
      name TEXT NOT NULL,
      PRIMARY KEY (tournament_id, id),
      UNIQUE (tournament_id, seed)
    );
    CREATE TABLE IF NOT EXISTS real_result (
      tournament_id INTEGER NOT NULL REFERENCES tournament(id),
      round INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      winner_id TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tournament_id, round, idx)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_idem
      ON real_result (tournament_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS auto_advance (
      tournament_id INTEGER NOT NULL REFERENCES tournament(id),
      round INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      participant_id TEXT,                       -- BYE 时为晋级者；EMPTY 传播时为 NULL
      kind TEXT NOT NULL,                        -- BYE | EMPTY
      PRIMARY KEY (tournament_id, round, idx)
    );
  `);
  return db;
}
