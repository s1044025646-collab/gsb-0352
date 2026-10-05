import { DatabaseSync } from 'node:sqlite';
import { deriveBracket, downstreamKeys, matchKey, nextPow2 } from './core.ts';
import type { Participant, DerivedBracket, MatchView } from './core.ts';
import { Errors } from './errors.ts';

export interface TournamentRow {
  id: number; name: string; status: string; size: number | null;
  max_participants: number; version: number;
}

export class TournamentService {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  private getTournament(id: number): TournamentRow {
    const t = this.db.prepare('SELECT * FROM tournament WHERE id = ?').get(id) as TournamentRow | undefined;
    if (!t) throw Errors.notFound(`赛事 ${id} 不存在`);
    return t;
  }

  createTournament(name: string, maxParticipants = 1024) {
    if (!name || typeof name !== 'string') throw Errors.invalidInput('name 必填');
    if (!Number.isInteger(maxParticipants) || maxParticipants < 1) throw Errors.invalidInput('maxParticipants 必须为正整数');
    const r = this.db.prepare('INSERT INTO tournament (name, max_participants) VALUES (?, ?)').run(name, maxParticipants);
    return this.getTournament(Number(r.lastInsertRowid));
  }

  // 导入参赛者：数组顺序即种子顺序；id 为稳定编号，行重排不改变种子身份
  importParticipants(tournamentId: number, list: { id: string; name: string }[]) {
    const t = this.getTournament(tournamentId);
    if (t.status === 'frozen') throw Errors.alreadyFrozen();
    if (!Array.isArray(list) || list.length === 0) throw Errors.emptyTournament();
    if (list.length > t.max_participants) throw Errors.tooMany(t.max_participants);
    const seen = new Set<string>();
    for (const p of list) {
      if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name) {
        throw Errors.invalidInput('每个参赛者必须包含非空 id 与 name');
      }
      if (seen.has(p.id)) throw Errors.invalidInput(`参赛者编号重复: ${p.id}`);
      seen.add(p.id);
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM participant WHERE tournament_id = ?').run(tournamentId);
      const ins = this.db.prepare('INSERT INTO participant (tournament_id, id, seed, name) VALUES (?, ?, ?, ?)');
      list.forEach((p, i) => ins.run(tournamentId, p.id, i + 1, p.name));
      this.bumpVersion(tournamentId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.listParticipants(tournamentId);
  }

  listParticipants(tournamentId: number): Participant[] {
    this.getTournament(tournamentId);
    return this.db.prepare('SELECT id, seed, name FROM participant WHERE tournament_id = ? ORDER BY seed')
      .all(tournamentId) as unknown as Participant[];
  }

  // 生成并冻结签表：确定最小二次幂大小与种子位置，之后不可再改
  freeze(tournamentId: number) {
    const t = this.getTournament(tournamentId);
    if (t.status === 'frozen') throw Errors.alreadyFrozen();
    const participants = this.listParticipants(tournamentId);
    if (participants.length === 0) throw Errors.emptyTournament();
    const size = nextPow2(participants.length);
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE tournament SET status = 'frozen', size = ? WHERE id = ?").run(size, tournamentId);
      this.bumpVersion(tournamentId);
      this.persistAutoAdvances(tournamentId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.getBracket(tournamentId);
  }

  private loadRealResults(tournamentId: number): Map<string, string> {
    const rows = this.db.prepare('SELECT round, idx, winner_id FROM real_result WHERE tournament_id = ?')
      .all(tournamentId) as unknown as { round: number; idx: number; winner_id: string }[];
    return new Map(rows.map(r => [matchKey(r.round, r.idx), r.winner_id]));
  }

  private derive(tournamentId: number): DerivedBracket {
    const t = this.getTournament(tournamentId);
    if (t.status !== 'frozen' || !t.size) throw Errors.notFrozen();
    const participants = new Map(this.listParticipants(tournamentId).map(p => [p.seed, p.id]));
    return deriveBracket(t.size, participants, this.loadRealResults(tournamentId));
  }

  // 把推导出的自动晋级（BYE/EMPTY）持久化快照
  private persistAutoAdvances(tournamentId: number, bracket?: DerivedBracket) {
    const b = bracket ?? this.derive(tournamentId);
    this.db.prepare('DELETE FROM auto_advance WHERE tournament_id = ?').run(tournamentId);
    const ins = this.db.prepare('INSERT INTO auto_advance (tournament_id, round, idx, participant_id, kind) VALUES (?, ?, ?, ?, ?)');
    for (const m of b.matches) {
      if (m.resultKind === 'BYE') ins.run(tournamentId, m.round, m.index, m.winnerId, 'BYE');
      else if (m.resultKind === 'EMPTY') ins.run(tournamentId, m.round, m.index, null, 'EMPTY');
    }
  }

  getBracket(tournamentId: number) {
    const t = this.getTournament(tournamentId);
    const b = this.derive(tournamentId);
    return { tournament: t, ...b };
  }

  playable(tournamentId: number): MatchView[] {
    return this.derive(tournamentId).matches.filter(m => m.status === 'ready');
  }

  private bumpVersion(tournamentId: number) {
    this.db.prepare('UPDATE tournament SET version = version + 1 WHERE id = ?').run(tournamentId);
  }

  private checkVersion(t: TournamentRow, expectedVersion?: number) {
    if (expectedVersion !== undefined && expectedVersion !== t.version) throw Errors.staleVersion(t.version);
  }

  submitResult(tournamentId: number, round: number, index: number, winnerId: string,
    opts: { idempotencyKey?: string; expectedVersion?: number } = {}) {
    const t = this.getTournament(tournamentId);
    if (t.status !== 'frozen') throw Errors.notFrozen();
    if (typeof winnerId !== 'string' || !winnerId) throw Errors.invalidInput('winnerId 必填');
    this.checkVersion(t, opts.expectedVersion);

    // 幂等：同键同内容直接返回旧结果；同键不同内容拒绝
    if (opts.idempotencyKey) {
      const existing = this.db.prepare(
        'SELECT * FROM real_result WHERE tournament_id = ? AND idempotency_key = ?',
      ).get(tournamentId, opts.idempotencyKey) as
        { round: number; idx: number; winner_id: string } | undefined;
      if (existing) {
        if (existing.round === round && existing.idx === index && existing.winner_id === winnerId) {
          return { duplicated: true, ...this.getBracket(tournamentId) };
        }
        throw Errors.idempotencyConflict();
      }
    }

    const bracket = this.derive(tournamentId);
    const m = bracket.matches.find(x => x.round === round && x.index === index);
    if (!m) throw Errors.notFound(`场次 ${round}:${index} 不存在`);
    if (m.status === 'decided' || m.status === 'empty') throw Errors.matchDecided();
    if (m.status !== 'ready') throw Errors.matchNotReady();
    const lp = m.left.kind === 'participant' ? m.left.participantId : null;
    const rp = m.right.kind === 'participant' ? m.right.participantId : null;
    if (winnerId !== lp && winnerId !== rp) throw Errors.winnerNotInMatch();

    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        'INSERT INTO real_result (tournament_id, round, idx, winner_id, idempotency_key) VALUES (?, ?, ?, ?, ?)',
      ).run(tournamentId, round, index, winnerId, opts.idempotencyKey ?? null);
      this.bumpVersion(tournamentId);
      this.persistAutoAdvances(tournamentId);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { duplicated: false, ...this.getBracket(tournamentId) };
  }

  // 撤销真实结果：仅当其下游没有任何真实结果时允许；自动晋级由回放自动清理重建
  undoResult(tournamentId: number, round: number, index: number, expectedVersion?: number) {
    const t = this.getTournament(tournamentId);
    if (t.status !== 'frozen' || !t.size) throw Errors.notFrozen();
    this.checkVersion(t, expectedVersion);
    const real = this.db.prepare('SELECT * FROM real_result WHERE tournament_id = ? AND round = ? AND idx = ?')
      .get(tournamentId, round, index);
    if (!real) throw Errors.notRealResult();

    const reals = this.loadRealResults(tournamentId);
    const blockers = downstreamKeys(t.size, round, index).filter(k => reals.has(k));
    if (blockers.length > 0) throw Errors.undoBlocked(blockers);

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM real_result WHERE tournament_id = ? AND round = ? AND idx = ?')
        .run(tournamentId, round, index);
      this.bumpVersion(tournamentId);
      this.persistAutoAdvances(tournamentId); // 重新推导，清理受影响的自动晋级，不触碰无关分支
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.getBracket(tournamentId);
  }

  // 参赛路径：某参赛者参与的每一场（真实或轮空晋级）
  participantPath(tournamentId: number, participantId: string) {
    const participants = this.listParticipants(tournamentId);
    if (!participants.some(p => p.id === participantId)) throw Errors.notFound(`参赛者 ${participantId} 不存在`);
    const b = this.derive(tournamentId);
    return b.matches
      .filter(m =>
        (m.left.kind === 'participant' && m.left.participantId === participantId) ||
        (m.right.kind === 'participant' && m.right.participantId === participantId) ||
        (m.resultKind === 'BYE' && m.winnerId === participantId))
      .map(m => ({
        round: m.round, index: m.index, status: m.status,
        winnerId: m.winnerId, resultKind: m.resultKind,
        left: m.left, right: m.right,
      }));
  }

  // 回放：从持久化的真实结果重新推导，返回与运行态一致的可比赛列表与冠军
  replay(tournamentId: number) {
    const b = this.derive(tournamentId);
    return {
      playable: b.matches.filter(m => m.status === 'ready'),
      championId: b.championId,
      realResults: [...this.loadRealResults(tournamentId).entries()].map(([k, w]) => ({ match: k, winnerId: w })),
    };
  }

  export(tournamentId: number) {
    const t = this.getTournament(tournamentId);
    const participants = this.listParticipants(tournamentId);
    const bracket = this.derive(tournamentId);
    const autoAdvances = this.db.prepare('SELECT round, idx, participant_id, kind FROM auto_advance WHERE tournament_id = ? ORDER BY round, idx')
      .all(tournamentId);
    return { tournament: t, participants, bracket, autoAdvances };
  }
}
