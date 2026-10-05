import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import { deriveBracket, type RealResultRow } from "./engine.js";
import type { Entrant } from "./types.js";

export interface TournamentRow {
  id: number;
  name: string;
  size: number | null;
  frozen: number;
  version: number;
}

export interface TournamentDetail extends TournamentRow {
  entrants: Entrant[];
  results: RealResultRow[];
}

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tournament (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      size INTEGER,
      frozen INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS entrant (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
      seed_no INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(tournament_id, seed_no)
    );
    CREATE TABLE IF NOT EXISTS match_result (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
      match_id TEXT NOT NULL,
      winner_entrant_id INTEGER NOT NULL REFERENCES entrant(id),
      idem_key TEXT NOT NULL,
      created_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tournament_id, match_id),
      UNIQUE(tournament_id, idem_key)
    );
    CREATE TABLE IF NOT EXISTS auto_advance (
      tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
      match_id TEXT NOT NULL,
      winner_entrant_id INTEGER NOT NULL REFERENCES entrant(id),
      PRIMARY KEY (tournament_id, match_id)
    );
  `);
  db.prepare(
    "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1')",
  ).run();
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

 transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  createTournament(name: string): TournamentRow {
    const info = this.db
      .prepare("INSERT INTO tournament(name) VALUES (?)")
      run(name);
    return this.getTournamentRow(Number(info.lastInsertRowid));
  }

  getTournamentRow(id: number): TournamentRow {
    const row = this.db
      .prepare("SELECT * FROM tournament WHERE id = ?")
      .get(id) as TournamentRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", `赛事 ${id} 不存在`);
    return row;
  }

  listTournaments(): TournamentRow[] {
    return this.db
      .prepare("SELECT * FROM tournament ORDER BY id")
      .all() as TournamentRow[];
  }

  getEntrants(tournamentId: number): Entrant[] {
    const rows = this.db
      .prepare(
        "SELECT id, tournament_id AS tournamentId, seed_no AS seedNo, name FROM entrant WHERE tournament_id = ? ORDER BY seed_no",
      )
      .all(tournamentId) as Array<{
      id: number;
      seedNo: number;
      name: string;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, seedNo: r.seedNo }));
  }

  getResults(tournamentId: number): RealResultRow[] {
    return this.db
      .prepare(
        `SELECT id, match_id AS matchId, winner_entrant_id AS winnerEntrantId,
                idem_key AS idemKey
         FROM match_result WHERE tournament_id = ? ORDER BY id`,
      )
      .all(tournamentId) as RealResultRow[];
  }

  loadDetail(id: number): TournamentDetail {
    const row = this.getTournamentRow(id);
    return {
      ...row,
      entrants: this.getEntrants(id),
      results: this.getResults(id),
    };
  }

  addEntrants(tournamentId: number, items: Array<{ seedNo: number; name: string }>): void {
    const stmt = this.db.prepare(
      "INSERT INTO entrant(tournament_id, seed_no, name) VALUES (?, ?, ?)",
    );
    for (const item of items) stmt.run(tournamentId, item.seedNo, item.name);
  }

  freeze(tournamentId: number, size: number): void {
    this.db
      .prepare("UPDATE tournament SET frozen = 1, size = ? WHERE id = ?")
      .run(size, tournamentId);
  }

  findResultByIdemKey(tournamentId: number, idemKey: string): RealResultRow | undefined {
    return this.db
      .prepare(
        `SELECT id, match_id AS matchId, winner_entrant_id AS winnerEntrantId,
                idem_key AS idemKey
         FROM match_result WHERE tournament_id = ? AND idem_key = ?`,
      )
      .get(tournamentId, idemKey) as RealResultRow | undefined;
  }

  findResultByMatch(tournamentId: number, matchId: string): RealResultRow | undefined {
    return this.db
      .prepare(
        `SELECT id, match_id AS matchId, winner_entrant_id AS winnerEntrantId,
                idem_key AS idemKey
         FROM match_result WHERE tournament_id = ? AND match_id = ?`,
      )
      .get(tournamentId, matchId) as RealResultRow | undefined;
  }

  maxSeq(tournamentId: number): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(created_seq), 0) AS s FROM match_result WHERE tournament_id = ?",
      )
      .get(tournamentId) as { s: number };
    return row.s;
  }

  insertResult(
    tournamentId: number,
    matchId: string,
    winnerEntrantId: number,
    idemKey: string,
    seq: number,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO match_result(tournament_id, match_id, winner_entrant_id, idem_key, created_seq)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tournamentId, matchId, winnerEntrantId, idemKey, seq);
    return Number(info.lastInsertRowid);
  }

  deleteResult(tournamentId: number, resultId: number): void {
    this.db
      .prepare("DELETE FROM match_result WHERE tournament_id = ? AND id = ?")
      .run(tournamentId, resultId);
  }

  replaceAutoAdvances(tournamentId: number, autos: Array<{ matchId: string; winnerEntrantId: number }>): void {
    this.db.prepare("DELETE FROM auto_advance WHERE tournament_id = ?").run(tournamentId);
    const stmt = this.db.prepare(
      "INSERT INTO auto_advance(tournament_id, match_id, winner_entrant_id) VALUES (?, ?, ?)",
    );
    for (const auto of autos) stmt.run(tournamentId, auto.matchId, auto.winnerEntrantId);
  }

  bumpVersion(tournamentId: number): number {
    this.db
      .prepare("UPDATE tournament SET version = version + 1 WHERE id = ?")
      .run(tournamentId);
    return this.getTournamentRow(tournamentId).version;
  }

  /** 仅用于测试/演示：删除整个赛事。 */
  deleteTournament(tournamentId: number): void {
    this.db.prepare("DELETE FROM tournament WHERE id = ?").run(tournamentId);
  }
}

export { deriveBracket };
