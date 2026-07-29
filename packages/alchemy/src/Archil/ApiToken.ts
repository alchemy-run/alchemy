import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createApiToken,
  deleteApiToken,
  listApiTokens,
  retryTransient,
  type ApiTokenData,
} from "./Api.ts";
import { Credentials } from "./Credentials.ts";
import type { ArchilRegion } from "./Region.ts";
import type { Providers } from "./Providers.ts";

export interface ApiTokenProps {
  /**
   * Token name (1-100 characters). If omitted, a unique name is generated
   * from `${app}-${stage}-${id}`. Changing the name replaces the token.
   */
  name?: string;
  /**
   * Token description (max 500 characters). Changing it replaces the token.
   */
  description?: string;
  /**
   * Control-plane region the token is created in.
   *
   * @default the credentials' default region (`ARCHIL_REGION` or "aws-us-east-1")
   */
  region?: ArchilRegion;
}

export type ApiToken = Resource<
  "Archil.ApiToken",
  ApiTokenProps,
  {
    /** Token ID (hash). */
    tokenId: string;
    /** Token name. */
    name: string;
    /** Token description. */
    description: string | undefined;
    /** Last 4 characters of the token. */
    tokenSuffix: string | undefined;
    /** Region the token was created in. */
    region: ArchilRegion;
    /**
     * The full token value. Archil returns this exactly once at creation,
     * so it is persisted here for downstream consumers (bindings, CI
     * secrets). Empty for adopted/listed tokens whose value was never seen.
     */
    value: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

type ApiTokenAttributes = ApiToken["Attributes"];

/**
 * An Archil control-plane API token for programmatic access to disks,
 * serverless execution, and disk users.
 *
 * The `Archil.ConnectHttp` binding layer mints one of these per host
 * Function/Worker automatically, so the deployed code authenticates with
 * its own revocable token instead of your CLI credentials.
 *
 * @resource
 * @section Creating a Token
 * @example A token for CI
 * ```typescript
 * const token = yield* Archil.ApiToken("ci-token", {
 *   description: "deploys from GitHub Actions",
 * });
 *
 * yield* GitHub.Secret("archil-api-key", {
 *   owner: "me",
 *   repository: "my-repo",
 *   name: "ARCHIL_API_KEY",
 *   value: token.value,
 * });
 * ```
 *
 * @section Exposing a Token to a Function
 * @example Read the token value at runtime
 * Binding `token.value` in a Worker/Function's init phase injects it as a
 * secret; the returned accessor reads it back (as `Redacted`) at runtime.
 * ```typescript
 * const value = yield* token.value;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const apiKey = yield* value; // Redacted<string>
 *     return HttpServerResponse.text("ok");
 *   }),
 * };
 * ```
 *
 * @see https://docs.archil.com/api-reference/introduction
 */
export const ApiToken = Resource<ApiToken>("Archil.ApiToken");

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

const toAttributes = (
  token: ApiTokenData,
  region: ArchilRegion,
  value: Redacted.Redacted<string>,
): ApiTokenAttributes => ({
  tokenId: token.id,
  name: token.name,
  description: token.description,
  tokenSuffix: token.tokenSuffix,
  region,
  value,
});

export const ApiTokenProvider = () =>
  Provider.succeed(ApiToken, {
    stables: ["tokenId", "region", "value", "tokenSuffix"],
    list: Effect.fn(function* () {
      const { defaultRegion } = yield* yield* Credentials;
      // The token value is only ever returned at creation; hydrate an empty
      // redacted placeholder for enumerated tokens.
      const tokens = yield* listApiTokens({
        region: defaultRegion,
        limit: 100,
      }).pipe(retryTransient);
      return tokens.map((t) =>
        toAttributes(t, defaultRegion, Redacted.make("")),
      );
    }),
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      if (!isResolved(news)) return undefined;
      const oldName = output?.name ?? (yield* resolveName(id, olds.name));
      const newName = news.name ?? oldName;
      const { defaultRegion } = yield* yield* Credentials;
      const oldRegion = output?.region ?? olds.region ?? defaultRegion;
      // There is no update API: any change is a replacement (a new token
      // value is minted).
      if (
        newName !== oldName ||
        (news.region ?? oldRegion) !== oldRegion ||
        (news.description ?? undefined) !== (olds.description ?? undefined)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output?.tokenId) return undefined;
      // There is no get-token endpoint; observe through the list.
      const tokens = yield* listApiTokens({
        region: output.region,
        limit: 100,
      });
      const match = tokens.find((t) => t.id === output.tokenId);
      return match
        ? toAttributes(match, output.region, output.value)
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { defaultRegion } = yield* yield* Credentials;
      const region = news.region ?? output?.region ?? defaultRegion;
      const name =
        news.name ?? output?.name ?? (yield* resolveName(id, undefined));

      // Observe — token ids are stable; the list endpoint is the only way
      // to check existence.
      const observed = output?.tokenId
        ? (yield* listApiTokens({ region, limit: 100 }).pipe(
            retryTransient,
          )).find((t) => t.id === output.tokenId)
        : undefined;

      // Ensure — create if missing. The plaintext value is returned exactly
      // once, so persist it; on subsequent reconciles preserve the captured
      // value (there is nothing mutable to sync).
      if (observed === undefined) {
        const created = yield* createApiToken({
          region,
          name,
          description: news.description,
        }).pipe(retryTransient);
        return toAttributes(created, region, Redacted.make(created.token));
      }
      return toAttributes(observed, region, output!.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteApiToken({
        region: output.region,
        tokenId: output.tokenId,
      }).pipe(
        retryTransient,
        Effect.catchTag("ApiTokenNotFound", () => Effect.void),
      );
    }),
  });
