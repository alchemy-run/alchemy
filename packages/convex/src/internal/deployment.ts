import * as Effect from "effect/Effect";
import { Credentials, fromDeployment } from "../Credentials.ts";

/** Run a Deployment API call against one deployment with the current token. */
export const onDeployment = <A, E, R>(url: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { token } = yield* yield* Credentials;
    return yield* effect.pipe(Effect.provide(fromDeployment({ url, token })));
  });

/**
 * The failures a Deployment API call gets once its deployment has gone: the
 * URL stops resolving, and its keys go with it. A delete treats these as done.
 */
export const GONE = [
  "NotFound",
  "Unauthorized",
  "MalformedAccessToken",
  "BadDeployKey",
  "HttpClientError",
] as const;
