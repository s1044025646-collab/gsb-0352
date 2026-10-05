import { buildLeaves } from "./seeding.js";
import type {
  Entrant,
  MatchDef,
  MatchState,
  Resolution,
  ReplayEvent,
} from "./types.js";

export interface RealResultRow {
  id: number;
  matchId: string;
  winnerEntrantId: number;
  idemKey: string;
}

export interface AutoAdvanceRow {
  matchId: string;
  winnerEntrantId: number;
}

export interface DerivedBracket {
  matches: MatchState[];
  byId: Map<string, MatchState>;
  autos: AutoAdvanceRow[];
  championId: number | null;
  events: ReplayEvent[];
}

/** 构造整棵比赛树（不含状态）。size=1 时无比赛。 */
export function buildMatchTree(size: number): MatchDef[] {
  const rounds = Math.log2(size);
  const defs: MatchDef[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let m = 1; m <= count; m++) {
      defs.push({
        id: matchId(r, m),
        round: r,
        seq: m,
        left:
          r === 1
            ? { kind: "leaf", index: 2 * (m - 1) }
            : { kind: "match", index: 2 * m - 1 },
        right:
          r === 1
            ? { kind: "leaf", index: 2 * m - 1 }
            : { kind: "match", index: 2 * m },
      });
    }
  }
  return defs;
}

export function matchId(round: number, seq: number): string {
  return `R${round}-M${seq}`;
}

export function totalRounds(size: number): number {
  return Math.log2(size);
}

const PENDING: Resolution = { status: "pending", entrantId: null };
const EMPTY: Resolution = { status: "empty", entrantId: null };
const resolvedEntrant = (id: number): Resolution => ({
  status: "resolved",
  entrantId: id,
});

/**
 * 从签位与真实结果完整推导签表状态。
 * 自动晋级是确定性派生量，一并重新生成（由持久层覆写 auto_advance 表）。
 */
export function deriveBracket(
  size: number,
  entrants: Entrant[],
  results: RealResultRow[],
): DerivedBracket {
  const leaves = buildLeaves(entrants, size);
  const defs = buildMatchTree(size);
  const resultByMatch = new Map(results.map((r) => [r.matchId, r]));
  const byId = new Map<string, MatchState>();
  const autos: AutoAdvanceRow[] = [];
  const events: ReplayEvent[] = [];

  // 按轮次推进；每一轮的来源要么是 leaf，要么是上一轮已算出的比赛。
  const previousRound = new Map<string, MatchState>();
  for (const def of defs) {
    const resolve = (
      ref: MatchDef["left"],
      round: number,
    ): Resolution => {
      if (ref.kind === "leaf") {
        const leaf = leaves[ref.index];
        if (!leaf) throw new Error(`签位下标越界: ${ref.index}`);
        return leaf.entrantId === null
          ? EMPTY
          : resolvedEntrant(leaf.entrantId);
      }
      const child = previousRound.get(matchId(round - 1, ref.index));
      if (!child) throw new Error(`缺少来源比赛 R${round - 1}-M${ref.index}`);
      if (child.basis === null) return PENDING;
      if (child.winnerId === null) return EMPTY;
      return resolvedEntrant(child.winnerId);
    };

    const leftResolution = resolve(def.left, def.round);
    const rightResolution = resolve(def.right, def.round);
    const sourcesResolved =
      leftResolution.status !== "pending" &&
      rightResolution.status !== "pending";
    const actuals = [leftResolution.entrantId, rightResolution.entrantId].filter(
      (id): id is number => id !== null,
    );

    let basis: MatchState["basis"] = null;
    let winnerId: number | null = null;
    let resultId: number | null = null;

    const result = resultByMatch.get(def.id);
    if (result) {
      basis = "result";
      winnerId = result.winnerEntrantId;
      resultId = result.id;
      events.push({
        type: "result",
        matchId: def.id,
        round: def.round,
        seq: def.seq,
        winnerId: result.winnerEntrantId,
        resultId: result.id,
      });
    } else if (sourcesResolved && actuals.length === 1) {
      // 两侧来源都已解决且恰有一名实际参赛者：轮空自动晋级。
      basis = "bye";
      winnerId = actuals[0]!;
      autos.push({ matchId: def.id, winnerEntrantId: winnerId });
      events.push({
        type: "bye",
        matchId: def.id,
        round: def.round,
        seq: def.seq,
        winnerId,
      });
    } else if (sourcesResolved && actuals.length === 0) {
      // 两侧都是已解决的空来源：继续向上传播空，不产生任何比赛或晋级。
      basis = null;
      winnerId = null;
    }

    const playable =
      basis === null &&
      sourcesResolved &&
      actuals.length === 2 &&
      leftResolution.entrantId !== rightResolution.entrantId;

    const state: MatchState = {
      ...def,
      leftResolution,
      rightResolution,
      basis,
      winnerId,
      resultId,
      sourcesResolved,
      playable,
    };
    byId.set(def.id, state);
    previousRound.set(def.id, state);
  }

  let championId: number | null = null;
  if (size === 1) {
    championId = entrants[0]?.id ?? null;
  } else {
    const rounds = totalRounds(size);
    const final = byId.get(matchId(rounds, 1));
    championId = final?.winnerId ?? null;
  }

  const matches = [...byId.values()];
  return { matches, byId, autos, championId, events };
}
