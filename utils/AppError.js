// utils/AppError.js
export class AppError extends Error {
  constructor(message, statusCode = 400, type = null) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.type = type; // <-- renamed from 'code' to 'type'
    this.isOperational = true; // distinguish from programming errors
    Error.captureStackTrace(this, this.constructor);
  }
}
