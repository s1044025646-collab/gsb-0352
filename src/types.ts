/**
 * 核心数据模型。
 *
 * 关键概念：
 * - leaf（首轮签位）：0..size-1，按种子展开顺序排列；空签位 entrantId 为 null。
 * - match（比赛节点）：id 形如 "R{round}-M{seq}"，round 从 1 开始（首轮），
 *   seq 为该轮内从左到右的场次序号（从 1 开始）。
 * - 来源：一场比赛的左右来源要么是首轮签位，要么是上一轮的另一场比赛。
 */

export type ResolutionStatus = "empty" | "pending" | "resolved";

/** 一个来源被解析后的结果：resolved=false 表示尚未决出；resolved=true 时 entrantId 可能为 null（已解决的空来源）。 */
export interface Resolution {
  status: ResolutionStatus;
  entrantId: number | null;
}

export interface Entrant {
  id: number;
  name: string;
  seedNo: number;
}

export interface MatchDef {
  id: string;
  round: number;
  seq: number;
  /** 左侧来源描述：首轮签位或上一轮比赛。 */
  left: SourceRef;
  right: SourceRef;
}

export type SourceKind = "leaf" | "match";

export interface SourceRef {
  kind: SourceKind;
  /** leaf 时为首轮签位下标；match 时为上一轮比赛的 seq（同一棵子树内序号）。 */
  index: number;
}

export type MatchBasis = "result" | "bye" | null;

/** 引擎推导出的一场比赛状态。 */
export interface MatchState extends MatchDef {
  leftResolution: Resolution;
  rightResolution: Resolution;
  /** 该场是否已产生参赛者：result=已提交实际结果；bye=轮空自动晋级；null=未产生。 */
  basis: MatchBasis;
  winnerId: number | null;
  resultId: number | null;
  /** 两侧都已解决。 */
  sourcesResolved: boolean;
  /** 两名实际参赛者均已确定，等待提交胜者。 */
  playable: boolean;
}

export interface TournamentSnapshot {
  id: number;
  name: string;
  size: number;
  frozen: boolean;
  version: number;
  entrants: Entrant[];
  leaves: Array<{ index: number; entrantId: number | null }>;
  matches: MatchState[];
  championId: number | null;
}

export interface BracketView {
  tournamentId: number;
  name: string;
  size: number;
  version: number;
  rounds: Array<{
    round: number;
    matches: MatchState[];
  }>;
  playable: MatchState[];
  championId: number | null;
}

export interface ReplayEvent {
  type: "result" | "bye";
  matchId: string;
  round: number;
  seq: number;
  winnerId: number;
  resultId?: number;
}
