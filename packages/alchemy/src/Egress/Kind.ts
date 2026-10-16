/**
 * Egress kinds (DESIGN.md §1): the rules for one service, the type of its
 * scope, and the tools and placeholder credentials a sandbox needs to use
 * it. A kind is named in a gateway declaration (`{ repo: GitHub.Egress }`)
 * and configured in the gateway's effectful constructor
 * (`yield* GitHub.Egress({ token, repositories })`).
 */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import * as Output from "../Output.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { RouteSpec } from "./Grant.ts";
import {
  cachedLookup,
  CREDENTIAL_TTL_MILLIS,
  type Credential,
  type CredentialInput,
  type EgressHandler,
  egressSecret,
} from "./Handler.ts";

export type { RouteSpec } from "./Grant.ts";

export const EgressKindTypeId = "~alchemy/EgressKind" as const;
export const ConfiguredEgressTypeId = "~alchemy/ConfiguredEgress" as const;

/**
 * An egress kind, as named in a gateway declaration. `Name` identifies it;
 * `Scope` is what `narrow` takes for egresses of this kind (`never`: no
 * narrowing).
 */
export interface EgressKind<Name extends string = string, Scope = never> {
  readonly [EgressKindTypeId]: Name;
  /**
   * Placeholder credentials and settings a sandbox's programs need: set when
   * an egress of this kind is granted (`GH_TOKEN=alchemy-egress`).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Tools a sandbox that accepts this kind needs, installed at deploy (`git`, `gh`). */
  readonly tools?: ReadonlyArray<ImageLayer>;
  /** @internal phantom — the scope `narrow` takes. */
  readonly "~alchemy/EgressScope"?: (scope: Scope) => void;
}

/** The name of an egress kind. */
export type KindName<K> = K extends { readonly [EgressKindTypeId]: infer N extends string }
  ? N
  : never;

/** The scope an egress kind's `narrow` takes. */
export type ScopeOf<K> = K extends {
  readonly "~alchemy/EgressScope"?: (scope: infer S) => void;
}
  ? S
  : never;

/** One granted egress: what a grant names, and what a sandbox stores. */
export interface EgressRef {
  /** The gateway's id: `"WorkGateway"`. */
  readonly gateway: string;
  /** Its name in the gateway: `"repo"`. */
  readonly egress: string;
  /** What `narrow()` was given. */
  readonly scope?: unknown;
  /** What `for()` was given. */
  readonly subject?: string;
}

/** A gateway's answer to `mint`: one grant for the refs asked for, and their routes. */
export interface MintedGrant {
  readonly gateway: { readonly id: string; readonly url: string };
  /** The grant, encoded: sent as `Authorization: Macaroon <grant>`. */
  readonly grant: string;
  /** When the grant expires (epoch milliseconds). */
  readonly expires: number;
  /** Each ref's routes, in the order the refs were given to `mint`. */
  readonly routes: ReadonlyArray<ReadonlyArray<RouteSpec>>;
}

/** The gateway won't serve this egress as asked (unknown, outside its configuration, …). */
export class EgressNotServed extends Data.TaggedError("EgressNotServed")<{
  readonly message: string;
  readonly gateway?: string;
  readonly egress?: string;
}> {}

/** What an egress is asked for: a ref's scope and subject. */
export interface EgressRequest {
  readonly scope?: unknown;
  readonly subject?: string;
}

/**
 * A configured egress of kind `Name`: what a gateway's constructor returns
 * for each declared egress (`yield* GitHub.Egress({ ... })`).
 */
export interface ConfiguredEgress<Name extends string = string> {
  readonly [ConfiguredEgressTypeId]: Name;
  /** Whether the credential is chosen per subject (`for(subject)`). */
  readonly perSubject: boolean;
  /** Fails with {@link EgressNotServed} if this egress won't serve `request`. */
  readonly allows: (request: EgressRequest) => Effect.Effect<void, EgressNotServed, RuntimeContext>;
  /** The hosts and paths `request` covers. */
  readonly routes: (
    request: EgressRequest,
  ) => Effect.Effect<ReadonlyArray<RouteSpec>, EgressNotServed, RuntimeContext>;
  /** The request handler for `request`: its rules, with the credential added. */
  readonly handler: (
    request: EgressRequest,
  ) => Effect.Effect<EgressHandler, EgressNotServed, RuntimeContext>;
  /** Placeholder credentials and settings a sandbox's programs need. */
  readonly env: Readonly<Record<string, string>>;
  /** Tools a sandbox image needs for this egress (`git`, `gh`). */
  readonly tools: ReadonlyArray<ImageLayer>;
}

export const isConfiguredEgress = (value: unknown): value is ConfiguredEgress =>
  typeof value === "object" && value !== null && ConfiguredEgressTypeId in value;

/** Check `request.subject` against whether the credential is per subject. */
export const checkSubject = (perSubject: boolean, request: EgressRequest) =>
  perSubject && request.subject === undefined
    ? Effect.fail(
        new EgressNotServed({
          message: "this egress chooses its credential per subject: use for()",
        }),
      )
    : !perSubject && request.subject !== undefined
      ? Effect.fail(
          new EgressNotServed({ message: "this egress has one credential: for() is not allowed" }),
        )
      : Effect.void;

/**
 * A kind's credential, configured: static (bound into the host at deploy) or
 * per subject (looked up per request, cached per subject briefly).
 */
export interface ResolvedCredential<A> {
  readonly perSubject: boolean;
  readonly get: (subject: string | undefined) => Effect.Effect<A, EgressNotServed, RuntimeContext>;
}

const isLookup = <A>(
  credential: Credential<A>,
): credential is (input: CredentialInput) => Effect.Effect<A, unknown, RuntimeContext> =>
  typeof credential === "function" && !Output.isOutput(credential) && !Config.isConfig(credential);

/**
 * Configure a credential in a constructor. A static secret is bound into the
 * host as `name` and read with `fromSecret`; a lookup runs per subject.
 */
export const resolveCredential = <A>(
  credential: Credential<A>,
  name: string,
  fromSecret: (secret: Redacted.Redacted<string>) => A,
): Effect.Effect<ResolvedCredential<A>> =>
  Effect.gen(function* () {
    if (isLookup(credential)) {
      const lookup = cachedLookup(CREDENTIAL_TTL_MILLIS, (subject: string) =>
        credential({ subject }).pipe(
          Effect.mapError(
            (cause) =>
              new EgressNotServed({
                message: `no credential for ${subject}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        ),
      );
      return {
        perSubject: true,
        get: (subject) =>
          subject === undefined
            ? Effect.fail(
                new EgressNotServed({ message: "this egress needs a subject: use for()" }),
              )
            : lookup(subject),
      };
    }
    const secret = yield* egressSecret(credential, name);
    return { perSubject: false, get: () => Effect.map(secret, fromSecret) };
  });
