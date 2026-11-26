export class AppError extends Error {
  constructor(message, { statusCode = 500, label = 'Server' } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.label = label;
  }
}

export function serverError(res, err, label = 'Server') {
  const statusCode = err.statusCode || 500;
  const message = statusCode >= 500 ? 'Internal server error' : err.message;
  console[statusCode >= 500 ? 'error' : 'warn'](`[${label}] ${statusCode}: ${err.message}`);
  res.status(statusCode).json({ error: message });
}