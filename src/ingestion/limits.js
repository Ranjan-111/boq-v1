const LIMITS = Object.freeze({
  uploadBytes: 10 * 1024 * 1024,
  pdfPages: 20,
  pdfOperators: 10000,
  pdfOperatorArgs: 50000,
  pdfPathOperators: 10000,
  pdfPathCoordinates: 20000,
  pdfTextItems: 10000,
  pdfVectorRegions: 1000,
  pdfRasterRegions: 1000,
  pdfRasterPixels: 25 * 1000 * 1000,
  pdfParseMs: 5000,
  pdfCleanupMs: 250
});

class LimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LimitError';
    this.code = details.code || 'limit_exceeded';
    this.retryable = details.retryable ?? false;
    Object.assign(this, details);
  }
}

module.exports = { LIMITS, LimitError };
