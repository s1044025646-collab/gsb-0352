// 核心签表逻辑：纯函数，不依赖数据库，便于测试与重启回放。

export interface Participant {
  id: string;        // 稳定编号（外部给定，作为公开 ID）
  seed: number;      // 种子序号，1 为头号种子
  name: string;
}

export type SourceState =
  | { kind: 'participant'; participantId: string }
  | { kind: 'empty' }     // 已确定的空来源（轮空位）
  | { kind: 'pending' };  // 来源尚未决出（上轮未完成），不是轮空

export type ResultKind = 'REAL' | 'BYE' | 'EMPTY';

export interface MatchView {
  round: number;        // 从 1 开始
  index: number;        // 轮内场次，从 0 开始
  left: SourceState;
  right: SourceState;
  status: 'pending' | 'ready' | 'decided' | 'empty';
  winnerId: string | null;
  resultKind: ResultKind | null;
}

export function nextPow2(n: number): number {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}

// 公开且确定的种子展开：从 [1,2] 开始，每个已有种子 s 展开为 s 与 newSize+1-s。
// 返回签位顺序：第 i 个签位放置种子 positions[i]。
export function seedOrder(size: number): number[] {
  if (size < 2) return [1];
  let pos = [1, 2];
  while (pos.length < size) {
    const ns = pos.length * 2;
    const next: number[] = [];
    for (const s of pos) next.push(s, ns + 1 - s);
    pos = next;
  }
  return pos;
}

export function matchKey(round: number, index: number): string {
  return `${round}:${index}`;
}

export interface DerivedBracket {
  size: number;
  rounds: number;
  matches: MatchView[];
  championId: string | null;
}

// 由真实结果回放推导整个签表（含轮空自动晋级与空来源传播）。
// participantsBySeed: seed -> participantId；realResults: "round:index" -> winnerId
export function deriveBracket(
  size: number,
  participantsBySeed: Map<number, string>,
  realResults: Map<string, string>,
): DerivedBracket {
  const rounds = size <= 1 ? 0 : Math.log2(size);
  const matches: MatchView[] = [];
  const byKey = new Map<string, MatchView>();
  const order = seedOrder(Math.max(size, 2));

  const resolveSeedSlot = (slot: number): SourceState => {
    const seed = order[slot];
    const pid = participantsBySeed.get(seed);
    return pid ? { kind: 'participant', participantId: pid } : { kind: 'empty' };
  };
  const resolveMatchSource = (round: number, index: number): SourceState => {
    const src = byKey.get(matchKey(round, index));
    if (!src) return { kind: 'pending' };
    if (src.status === 'decided' && src.winnerId) return { kind: 'participant', participantId: src.winnerId };
    if (src.status === 'empty') return { kind: 'empty' };
    return { kind: 'pending' };
  };

  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let i = 0; i < count; i++) {
      const left = r === 1 ? resolveSeedSlot(2 * i) : resolveMatchSource(r - 1, 2 * i);
      const right = r === 1 ? resolveSeedSlot(2 * i + 1) : resolveMatchSource(r - 1, 2 * i + 1);
      const key = matchKey(r, i);
      const real = realResults.get(key);
      let m: MatchView;
      if (real !== undefined) {
        m = { round: r, index: i, left, right, status: 'decided', winnerId: real, resultKind: 'REAL' };
      } else if (left.kind !== 'pending' && right.kind !== 'pending') {
        // 只有两侧来源都已解决，才允许自动晋级或空传播
        const lp = left.kind === 'participant' ? left.participantId : null;
        const rp = right.kind === 'participant' ? right.participantId : null;
        if (lp && rp) {
          m = { round: r, index: i, left, right, status: 'ready', winnerId: null, resultKind: null };
        } else if (lp || rp) {
          m = { round: r, index: i, left, right, status: 'decided', winnerId: (lp ?? rp)!, resultKind: 'BYE' };
        } else {
          m = { round: r, index: i, left, right, status: 'empty', winnerId: null, resultKind: 'EMPTY' };
        }
      } else {
        m = { round: r, index: i, left, right, status: 'pending', winnerId: null, resultKind: null };
      }
      matches.push(m);
      byKey.set(key, m);
    }
  }

  let championId: string | null = null;
  if (size === 1) {
    championId = participantsBySeed.get(1) ?? null; // 单人赛事：直接冠军，不生成比赛
  } else {
    const final = byKey.get(matchKey(rounds, 0));
    if (final && final.status === 'decided') championId = final.winnerId;
  }
  return { size, rounds, matches, championId };
}

// 计算某场比赛的所有下游（依赖其结果的）比赛 key 列表
export function downstreamKeys(size: number, round: number, index: number): string[] {
  const rounds = Math.log2(size);
  const out: string[] = [];
  let r = round;
  let i = index;
  while (r < rounds) {
    i = Math.floor(i / 2);
    r += 1;
    out.push(matchKey(r, i));
  }
  return out;
}
