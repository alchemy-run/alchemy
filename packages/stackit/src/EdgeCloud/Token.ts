import * as edge from "@distilled.cloud/stackit/edge";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { resolveProjectScope } from "../IaaS/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  credentialStaleReason,
  DEFAULT_EXPIRATION_SECONDS,
  diffCredential,
  mintWhenReady,
  refreshWindowOf,
  tokenValue,
} from "./internal.ts";

export interface TokenProps {
  /** Id of the instance, e.g. a `Stackit.EdgeCloud.Instance`'s `instanceId`. Changing it replaces the token. */
  instanceId: string;
  /**
   * How long each minted token stays valid, in seconds, from 600 (10 minutes) to
   * 15552000 (6 months). Changing it replaces the token. It can't be revoked once
   * minted, so keep it short.
   * @default 3600
   */
  expirationSeconds?: number;
  /**
   * Re-mint on a deploy this many seconds before expiry, so a deploy never leaves a
   * token that's about to lapse. Updates in place.
   * @default a tenth of `expirationSeconds`
   */
  refreshBeforeSeconds?: number;
  /** Project of the instance. Defaults to the profile's. Changing it replaces the token. */
  projectId?: string;
  /** Region of the instance. Defaults to the profile's. Changing it replaces the token. */
  region?: string;
}

export interface TokenAttributes {
  /** Id of the instance. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** The service account token. Grants access to the instance's Kubernetes API. */
  token: Redacted.Redacted<string>;
  /** The lifetime it was minted with, in seconds. */
  expirationSeconds: number;
  /** When this token was minted, by the deploying machine's clock. */
  mintedAt: string;
  /** When this token stops working, counted from `mintedAt`, as the API reports no expiry. */
  expiresAt: string;
  /** When the instance it belongs to was created, which tells a recreated instance from this one. */
  instanceCreated: string;
}

export type Token = Resource<
  "Stackit.EdgeCloud.Token",
  TokenProps,
  TokenAttributes,
  never,
  Providers
>;

/**
 * A short-lived service account token for the Kubernetes API of a STACKIT Edge Cloud
 * instance, for clients that take a bearer token rather than a kubeconfig.
 *
 * ### How Expiry Works <!-- api-prose -->
 * The API mints a token on each call. It has no way to read one back, list it or
 * revoke it, so this resource holds the one it minted and replaces it when it stops
 * being useful. Every plan checks two things, and a deploy mints a new token when
 * either holds:
 *
 * - it is within `refreshBeforeSeconds` of `expiresAt`, or past it;
 * - its instance is gone, or was recreated under the same id.
 *
 * Between deploys nothing renews it. Its consumers must redeploy before `expiresAt`,
 * so set `expirationSeconds` longer than the gap between your deploys. For a process
 * that runs on its own schedule, mint at runtime with `Stackit.EdgeCloud.GetToken`.
 *
 * Destroying this resource only forgets the token: it stays valid until it expires.
 * The value is held `Redacted` in the state store.
 *
 * ### Creating a Token
 * **Example:** A token valid for a day
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const edge = yield* Stackit.EdgeCloud.Instance("Edge", {
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 * const token = yield* Stackit.EdgeCloud.Token("HostToken", {
 *   instanceId: edge.instanceId,
 *   expirationSeconds: 24 * 3600,
 * });
 * ```
 *
 * ### Using the Token
 * **Example:** Hand it to another system as a secret
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const edge = yield* Stackit.EdgeCloud.Instance("Edge", {
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 * const token = yield* Stackit.EdgeCloud.Token("HostToken", {
 *   instanceId: edge.instanceId,
 *   expirationSeconds: 30 * 24 * 3600,
 * });
 * // Stays `Redacted`; a redeploy updates the Worker whenever it is re-minted.
 * yield* Cloudflare.Worker("Operator", {
 *   main: "./src/operator.ts",
 *   env: { EDGE_TOKEN: token.token },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export const Token = Resource<Token>("Stackit.EdgeCloud.Token");

export const TokenProvider = () =>
  Provider.succeed(Token, {
    stables: ["instanceId", "projectId", "region"],
    // No `list`: the API can't enumerate tokens, and they expire by themselves.

    diff: ({ news, output }) => diffCredential(news, output),

    read: Effect.fn(function* ({ output }) {
      // The API can't find a token, so there's nothing to recover or adopt.
      if (output === undefined) return undefined;
      const stale = yield* credentialStaleReason(output, 0);
      return stale === undefined ? output : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const { instanceId } = news;
      const expirationSeconds = news.expirationSeconds ?? DEFAULT_EXPIRATION_SECONDS;

      // Observe: the held token, while it is for this instance and still good.
      if (
        output !== undefined &&
        output.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region &&
        output.expirationSeconds === expirationSeconds &&
        (yield* credentialStaleReason(
          output,
          refreshWindowOf(news.refreshBeforeSeconds, expirationSeconds),
        )) === undefined
      ) {
        return output;
      }

      // Ensure: mint a new one. A missing instance fails with the typed `NotFound`.
      const { credential, ...minted } = yield* mintWhenReady({
        resource: `a token of STACKIT Edge Cloud instance ${instanceId}`,
        scope,
        instanceId,
        expirationSeconds,
        mint: edge
          .getTokenByInstanceId({
            projectId: scope.projectId,
            regionId: scope.region,
            instanceId,
            expirationSeconds,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      });
      return {
        instanceId,
        projectId: scope.projectId,
        region: scope.region,
        token: tokenValue(credential.token),
        expirationSeconds,
        ...minted,
      };
    }),

    // The API has no revoke: a token stays valid until it expires. Deleting only
    // forgets it.
    delete: () => Effect.void,
  });
