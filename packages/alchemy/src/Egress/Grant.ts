/**
 * Egress grants (DESIGN.md §11): an HMAC chain over structured caveats — the
 * useful part of macaroons, without third-party caveats or the binary
 * format. WebCrypto runs on Workers, Node, Bun and Lambda alike.
 *
 * A grant isn't a credential for GitHub or Anthropic. It lets its holder ask
 * one gateway to run the egresses it names, as narrowed, for the subjects it
 * names, until it expires. The signing key never leaves the gateway's host.
 *
 * Every caveat must hold. An egress caveat is satisfied by a request its
 * egress covers; `anyOf` by a request any of its egresses covers. A grant
 * for several egresses carries them as one `anyOf`, so appending another
 * caveat (`attenuate`) can only narrow it: a new `expires` shortens it, a new
 * egress caveat drops the alternatives it doesn't repeat.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { canonicalJson } from "./Canonical.ts";
import { mostSpecific } from "./Route.ts";

export { canonicalJson };

/** The grant is void at or after `expires` (epoch milliseconds). */
export interface ExpiresCaveat {
  readonly expires: number;
}

/** Run egress `egress` of the gateway, narrowed to `scope`, for `subject`. */
export interface EgressCaveat {
  readonly egress: string;
  readonly scope?: unknown;
  readonly subject?: string;
}

/** Any one of these egresses. */
export interface AnyOfCaveat {
  readonly anyOf: ReadonlyArray<EgressCaveat>;
}

export type Caveat = ExpiresCaveat | EgressCaveat | AnyOfCaveat;

export interface Grant {
  readonly id: string;
  readonly caveats: ReadonlyArray<Caveat>;
  /** Hex HMAC-SHA256. */
  readonly signature: string;
}

/** A grant that isn't well-formed on the wire. */
export class GrantDecodeError extends Data.TaggedError("GrantDecodeError")<{
  readonly message: string;
}> {}

/** Where an egress sends requests: a host, optionally narrowed to paths. */
export interface RouteSpec {
  readonly host: string;
  readonly paths?: ReadonlyArray<string>;
}

//#region encoding

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Hex → bytes; `undefined` for anything that isn't even-length hex. */
export const fromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

const toBase64Url = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (text: string) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

/** On the wire: base64url JSON. */
export const encode = (grant: Grant): string => toBase64Url(JSON.stringify(grant));

const isEgressCaveat = (value: unknown): value is EgressCaveat =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as EgressCaveat).egress === "string" &&
  ((value as EgressCaveat).subject === undefined ||
    typeof (value as EgressCaveat).subject === "string");

const isCaveat = (value: unknown): value is Caveat => {
  if (typeof value !== "object" || value === null) return false;
  if ("expires" in value) return typeof (value as ExpiresCaveat).expires === "number";
  if ("anyOf" in value) {
    const anyOf = (value as AnyOfCaveat).anyOf;
    return Array.isArray(anyOf) && anyOf.every(isEgressCaveat);
  }
  return isEgressCaveat(value);
};

/**
 * Parse an encoded grant, or the value of an `Authorization: Macaroon <grant>`
 * header. Checks the shape only; {@link verify} checks the signature.
 */
export const decode = (encoded: string | undefined): Effect.Effect<Grant, GrantDecodeError> =>
  Effect.try({
    try: () => {
      const token = (encoded ?? "").replace(/^\s*Macaroon\s+/i, "").trim();
      if (!token) throw new Error("no grant");
      const parsed: unknown = JSON.parse(fromBase64Url(token));
      const grant = parsed as Grant;
      if (
        typeof grant !== "object" ||
        grant === null ||
        typeof grant.id !== "string" ||
        typeof grant.signature !== "string" ||
        !Array.isArray(grant.caveats) ||
        !grant.caveats.every(isCaveat)
      ) {
        throw new Error("malformed grant");
      }
      return { id: grant.id, caveats: grant.caveats, signature: grant.signature };
    },
    catch: (cause) =>
      new GrantDecodeError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

//#endregion

//#region signing

const hmac = (key: Uint8Array, data: string) =>
  Effect.promise(async () => {
    const imported = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(data)),
    );
  });

/** sig₀ = HMAC(key, id); sigₙ = HMAC(sigₙ₋₁, caveatₙ) */
const chain = (key: Uint8Array, id: string, caveats: ReadonlyArray<Caveat>) =>
  Effect.gen(function* () {
    let signature = yield* hmac(key, id);
    for (const caveat of caveats) signature = yield* hmac(signature, canonicalJson(caveat));
    return signature;
  });

/** Sign a new grant with the gateway's key. */
export const mint = (
  key: Uint8Array,
  id: string,
  caveats: ReadonlyArray<Caveat>,
): Effect.Effect<Grant> =>
  chain(key, id, caveats).pipe(Effect.map((sig) => ({ id, caveats, signature: toHex(sig) })));

/** Anyone holding a grant can narrow it; nobody can widen it without the key. */
export const attenuate = (grant: Grant, caveat: Caveat): Effect.Effect<Grant> =>
  hmac(fromHex(grant.signature) ?? new Uint8Array(), canonicalJson(caveat)).pipe(
    Effect.map((sig) => ({
      ...grant,
      caveats: [...grant.caveats, caveat],
      signature: toHex(sig),
    })),
  );

/** Constant-time byte equality (length leaks; contents don't). */
const constantTimeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

/** Whether `grant` was signed with `key` (and only attenuated since). */
export const verify = (key: Uint8Array, grant: Grant): Effect.Effect<boolean> =>
  chain(key, grant.id, grant.caveats).pipe(
    Effect.map((sig) => {
      const claimed = fromHex(grant.signature);
      return claimed !== undefined && constantTimeEqual(sig, claimed);
    }),
  );

//#endregion

//#region checking

/** When the grant expires: its earliest `expires` caveat. */
export const expiry = (grant: Grant): number | undefined => {
  let earliest: number | undefined;
  for (const caveat of grant.caveats) {
    if ("expires" in caveat && (earliest === undefined || caveat.expires < earliest)) {
      earliest = caveat.expires;
    }
  }
  return earliest;
};

/** Whether any `expires` caveat has passed at `now`. */
export const isExpired = (grant: Grant, now: number): boolean => {
  const expires = expiry(grant);
  return expires !== undefined && now >= expires;
};

/** The egress caveats, as clauses of alternatives (each clause must hold). */
const clauses = (grant: Grant): ReadonlyArray<ReadonlyArray<EgressCaveat>> =>
  grant.caveats.flatMap((caveat) =>
    "expires" in caveat ? [] : "anyOf" in caveat ? [caveat.anyOf] : [[caveat]],
  );

/**
 * The egress that serves a request to `target`: the alternative of the
 * grant's first egress clause whose routes match most specifically, provided
 * every later clause repeats it. `undefined` when the grant has expired or no
 * granted egress covers the target. `routesOf` gives each egress's routes
 * (the gateway asks the egress itself; a grant never carries routes).
 */
export const covering = <E, R>(
  grant: Grant,
  target: { readonly host: string; readonly path: string },
  now: number,
  routesOf: (caveat: EgressCaveat) => Effect.Effect<ReadonlyArray<RouteSpec>, E, R>,
): Effect.Effect<EgressCaveat | undefined, E, R> =>
  Effect.gen(function* () {
    if (isExpired(grant, now)) return undefined;
    const [first, ...rest] = clauses(grant);
    if (!first) return undefined;
    const candidates: Array<RouteSpec & { readonly caveat: EgressCaveat }> = [];
    for (const caveat of first) {
      for (const route of yield* routesOf(caveat)) candidates.push({ ...route, caveat });
    }
    const match = mostSpecific(candidates, target.host, target.path);
    if (!match) return undefined;
    const chosen = canonicalJson(match.caveat);
    return rest.every((clause) => clause.some((caveat) => canonicalJson(caveat) === chosen))
      ? match.caveat
      : undefined;
  });

//#endregion
