import { createAuthClient } from "better-auth/client";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** better-auth's browser client, on the app's own origin. */
export const auth = createAuthClient();

/** better-auth could not be reached, or answered with an error. */
export class AuthFailed extends Data.TaggedError("AuthFailed")<{ readonly message: string }> {}

/**
 * Call better-auth's client as an Effect. The client returns a Promise of
 * `{ data, error }`: a rejection (the network) and an `error` (the server) both
 * fail with `AuthFailed`, so neither can slip past as a success or a defect.
 */
export const callAuth = <A>(
  call: () => Promise<
    | { data: A; error: null }
    | { data: null; error: { message?: string | undefined; statusText: string } }
  >,
) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new AuthFailed({ message: String(cause) }),
  }).pipe(
    Effect.flatMap(({ data, error }) =>
      error === null
        ? Effect.succeed(data)
        : Effect.fail(new AuthFailed({ message: error.message ?? error.statusText })),
    ),
  );
