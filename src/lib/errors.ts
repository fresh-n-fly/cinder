/**
 * An error whose message was written for the person using the page.
 *
 * Only these messages are sent to clients. Anything else (database driver
 * errors, parser errors, bugs) is answered with a generic message so internal
 * details and echoed input never reach the response.
 */
export class PublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

export const BUSY_ERROR = "The server is busy. Try again in a moment.";
export const GENERIC_ERROR = "Something went wrong. Try again.";
