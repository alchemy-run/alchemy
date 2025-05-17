/**
 * Custom error class for Upstash API errors
 */
export class UpstashError extends Error {
  /**
   * HTTP status code
   */
  statusCode: number;

  /**
   * Original response object
   */
  response: Response;

  /**
   * Create a new Upstash error
   *
   * @param message Error message
   * @param statusCode HTTP status code
   * @param response Original response object
   */
  constructor(message: string, statusCode: number, response: Response) {
    super(message);
    this.name = "UpstashError";
    this.statusCode = statusCode;
    this.response = response;
  }
}
