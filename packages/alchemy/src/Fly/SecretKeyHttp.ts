/**
 * Shared scaffolding for Fly SecretKey HTTP bindings.
 *
 * NOT exported from `index.ts`.
 */
import * as Effect from "effect/Effect";
import type { SecretAuth } from "./SecretHttp.ts";
import { makeHttpSecretBinding } from "./SecretHttp.ts";
import type { SecretKey } from "./SecretKey.ts";

export const toByteList = (bytes: Uint8Array | ArrayLike<number>): number[] =>
  Array.from(bytes);

export const fromByteList = (
  bytes: ReadonlyArray<number> | undefined,
): Uint8Array => Uint8Array.from(bytes ?? []);

export const bytesToBase64 = (bytes: Uint8Array | ArrayLike<number>): string =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes),
  ).toString("base64");

export const base64ToBytes = (value: string | undefined): Uint8Array =>
  Uint8Array.from(Buffer.from(value ?? "", "base64"));

/**
 * PetSem crypto over the Machine unix socket. Fly expects base64 strings,
 * not integer arrays. Org tokens are Forbidden; `/.fly/api` is the
 * machine identity.
 */
export const flyKmsPost = (
  appName: string,
  secretName: string,
  op: "encrypt" | "decrypt" | "sign" | "verify",
  body: Record<string, unknown>,
) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(
        `http://localhost/v1/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}/${op}`,
        {
          method: "POST",
          unix: "/.fly/api",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        } as RequestInit,
      );
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status}: ${text}`);
      }
      if (text.length === 0) return {};
      return JSON.parse(text) as Record<string, unknown>;
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

export const makeHttpSecretKeyBinding = <Client>(options: {
  makeClient: (
    auth: SecretAuth,
    appName: Effect.Effect<string>,
    secretName: Effect.Effect<string>,
  ) => Client;
}) => makeHttpSecretBinding<SecretKey, Client>({ ...options, kms: true });
