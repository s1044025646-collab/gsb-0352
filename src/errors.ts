export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  invalidInput: (msg: string, details?: unknown) => new ApiError(400, 'INVALID_INPUT', msg, details),
  notFound: (msg = '资源不存在') => new ApiError(404, 'NOT_FOUND', msg),
  emptyTournament: () => new ApiError(400, 'EMPTY_TOURNAMENT', '参赛者人数为零，拒绝创建签表'),
  tooMany: (max: number) => new ApiError(400, 'TOO_MANY_PARTICIPANTS', `参赛者人数超过上限 ${max}`),
  alreadyFrozen: () => new ApiError(409, 'ALREADY_FROZEN', '签表已冻结，参赛者与种子不可再修改'),
  notFrozen: () => new ApiError(409, 'NOT_FROZEN', '签表尚未冻结，请先冻结'),
  matchNotReady: () => new ApiError(409, 'MATCH_NOT_READY', '该场次两侧参赛者尚未全部确定，不能提交结果'),
  matchDecided: () => new ApiError(409, 'MATCH_ALREADY_DECIDED', '该场次已有结果'),
  winnerNotInMatch: () => new ApiError(400, 'WINNER_NOT_IN_MATCH', '胜者不属于本场比赛的参赛者'),
  idempotencyConflict: () => new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键提交了不同内容'),
  staleVersion: (current: number) => new ApiError(409, 'STALE_VERSION', `版本过期，当前版本为 ${current}`, { currentVersion: current }),
  undoBlocked: (blockers: string[]) => new ApiError(409, 'UNDO_BLOCKED', '下游已存在真实比赛结果，禁止撤销', { blockingMatches: blockers }),
  notRealResult: () => new ApiError(400, 'NOT_REAL_RESULT', '该场次没有可撤销的真实比赛结果'),
};
