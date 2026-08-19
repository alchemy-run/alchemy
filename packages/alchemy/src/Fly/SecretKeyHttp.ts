/**
 * Shared scaffolding for Fly SecretKey HTTP bindings.
 *
 * NOT exported from `index.ts`.
 */
import type * as Effect from "effect/Effect";
import type { SecretAuth } from "./SecretHttp.ts";
import { makeHttpSecretBinding } from "./SecretHttp.ts";
import type { SecretKey } from "./SecretKey.ts";

export const toByteList = (bytes: Uint8Array | ArrayLike<number>): number[] =>
  Array.from(bytes);

export const fromByteList = (
  bytes: ReadonlyArray<number> | undefined,
): Uint8Array => Uint8Array.from(bytes ?? []);

export const makeHttpSecretKeyBinding = <Client>(options: {
  makeClient: (
    auth: SecretAuth,
    appName: Effect.Effect<string>,
    secretName: Effect.Effect<string>,
  ) => Client;
}) => makeHttpSecretBinding<SecretKey, Client>(options);
