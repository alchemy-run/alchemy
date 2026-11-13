/** The `message` of a failure of any type (SDK errors carry the API's text). */
export const messageOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : undefined;

/** A driver error's `code`, e.g. Postgres `28P01` (invalid password). */
export const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
