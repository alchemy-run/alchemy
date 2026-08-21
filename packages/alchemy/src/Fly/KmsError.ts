import * as Data from "effect/Data";

/**
 * Failure of a Fly PetSem (KMS) call made from inside a Machine over the
 * `/.fly/api` unix socket.
 *
 * The distilled Machines SDK cannot reach that socket, so
 * {@link Encrypt}, {@link Decrypt}, {@link Sign}, and {@link Verify} post
 * directly when running inside a deployed host. This is the typed error
 * for that path — a non-2xx response, or a socket/transport failure.
 */
export class FlyKmsError extends Data.TaggedError("Fly.KmsError")<{
  /** The PetSem operation that failed. */
  readonly op: "encrypt" | "decrypt" | "sign" | "verify";
  /** HTTP status, when Fly answered at all. */
  readonly status?: number;
  /** Response body, or the transport failure message. */
  readonly message: string;
  readonly cause?: unknown;
}> {}
