export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "TOURNAMENT_FROZEN"
  | "TOURNAMENT_NOT_FROZEN"
  | "NO_ENTRANTS"
  | "TOO_MANY_ENTRANTS"
  | "MATCH_NOT_FOUND"
  | "MATCH_NOT_PLAYABLE"
  | "INVALID_WINNER"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "NO_RESULT_TO_UNDO"
  | "DOWNSTREAM_BLOCKED"
  | "DUPLICATE_SEED"
  | "BAD_STATE";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.httpStatus = STATUS[code];
  }
}

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  TOURNAMENT_FROZEN: 409,
  TOURNAMENT_NOT_FROZEN: 409,
  NO_ENTRANTS: 422,
  TOO_MANY_ENTRANTS: 422,
  MATCH_NOT_FOUND: 404,
  MATCH_NOT_PLAYABLE: 409,
  INVALID_WINNER: 422,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  NO_RESULT_TO_UNDO: 404,
  DOWNSTREAM_BLOCKED: 409,
  DUPLICATE_SEED: 422,
  BAD_STATE: 500,
};
