export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: any;
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: any,
    isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'BAD_REQUEST', details?: any) {
    super(400, code, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: any) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized: Authentication required', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden: Access denied', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Rate limit exceeded. Please try again later.', code = 'TOO_MANY_REQUESTS') {
    super(429, code, message);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'An unexpected internal server error occurred', code = 'INTERNAL_SERVER_ERROR', details?: any) {
    super(500, code, message, details, false);
  }
}

