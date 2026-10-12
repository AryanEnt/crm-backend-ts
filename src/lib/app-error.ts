/** Stable machine-readable error codes, identical to the Go backend's apperrors codes. */
export const ErrorCode = {
  Validation: "validation_error",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  Internal: "internal_error",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = options.details;
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ErrorCode.Validation, message, 400, { details });
  }

  /** Validation error carrying { field, message } details. */
  static fieldValidation(field: string, message: string): AppError {
    return AppError.validation(message, { field, message });
  }

  static unauthorized(message: string): AppError {
    return new AppError(ErrorCode.Unauthorized, message, 401);
  }

  static forbidden(message: string): AppError {
    return new AppError(ErrorCode.Forbidden, message, 403);
  }

  static notFound(message: string): AppError {
    return new AppError(ErrorCode.NotFound, message, 404);
  }

  static conflict(message: string): AppError {
    return new AppError(ErrorCode.Conflict, message, 409);
  }

  static internal(message: string, cause?: unknown): AppError {
    return new AppError(ErrorCode.Internal, message, 500, { cause });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
