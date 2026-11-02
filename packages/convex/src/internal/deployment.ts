import * as Effect from "effect/Effect";
import { Credentials, fromDeployment } from "../Credentials.ts";

/** Run a Deployment API call against one deployment with the current token. */
export const onDeployment = <A, E, R>(url: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { token } = yield* yield* Credentials;
    return yield* effect.pipe(Effect.provide(fromDeployment({ url, token })));
  });

/**
 * What a Deployment API call gets once its deployment has gone: a 404, whatever
 * the token. A live deployment answers 401 to a revoked key, so an auth failure
 * must fail the delete rather than drop the state row and leave the data.
 */
export const GONE = ["NotFound"] as const;
