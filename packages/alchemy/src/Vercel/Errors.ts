import * as Data from "effect/Data";

/**
 * Typed errors for the Vercel REST API client.
 *
 * Auth uses a bearer token (`VERCEL_TOKEN`). Team-owned domains additionally
 * need `teamId` (or `teamSlug`), sent as a query parameter on every call.
 *
 * @see https://vercel.com/docs/rest-api
 */
export class VercelError extends Data.TaggedError("VercelError")<{
  readonly status: number;
  readonly code?: string;
  readonly message: string;
}> {}

export class VercelNotFound extends Data.TaggedError("VercelNotFound")<{
  readonly message: string;
}> {}

export class VercelMissingCredentials extends Data.TaggedError(
  "VercelMissingCredentials",
)<{
  readonly message: string;
}> {}
