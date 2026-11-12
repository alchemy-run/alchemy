import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/clickhouse-cloud/Credentials";
import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  CLICKHOUSE_CLOUD_AUTH_PROVIDER_NAME,
  type ClickHouseCloudResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/clickhouse-cloud/Credentials";

/**
 * The ClickHouse Cloud organization the current credentials act in. Every
 * API path carries it. Holds an effect so it resolves on first use, never
 * at layer build; a success is cached, a failure is not.
 */
export class OrganizationId extends Context.Service<
  OrganizationId,
  Effect.Effect<string, ConfigError | organization.ListOrganizationsError>
>()("ClickHouseCloud.OrganizationId") {}

/** The organization ID of the current credentials. */
export const organizationId = Effect.flatten(OrganizationId);

const make = (
  resolve: Effect.Effect<ClickHouseCloudResolvedCredentials, ConfigError>,
): Effect.Effect<Context.Context<Credentials | OrganizationId>> =>
  Effect.gen(function* () {
    const credentials = Effect.map(resolve, (creds) => ({
      keyId: creds.keyId,
      keySecret: creds.keySecret,
      apiBaseUrl: creds.apiBaseUrl.replace(/\/+$/, ""),
    }));
    // An API key belongs to exactly one organization, so a profile without
    // an organization ID asks the API which one.
    const lookup = Effect.gen(function* () {
      const creds = yield* resolve;
      if (creds.organizationId !== undefined) return creds.organizationId;
      const { result } = yield* organization
        .listOrganizations({})
        .pipe(
          Effect.provide(
            Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
          ),
        );
      const id = result[0]?.id;
      if (id === undefined) {
        return yield* new ConfigError({
          message: "The ClickHouse Cloud API key belongs to no organization.",
        });
      }
      return id;
    });
    // Only a success is kept: a missing profile or a transient failure is
    // asked again on the next use (`Effect.cached` would keep the failure).
    const cachedOrganization = yield* Effect.cachedWithTTL(lookup, (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    );
    return Context.make(Credentials, credentials).pipe(
      Context.add(OrganizationId, cachedOrganization),
    );
  });

/**
 * Build ClickHouse Cloud `Credentials` + `OrganizationId` from an explicit
 * API key. Useful for tests, or for a runtime that reads its key from a
 * binding.
 *
 * @example
 * ```ts
 * Effect.provide(
 *   ClickHouseCloud.fromApiKey({
 *     keyId: "...",
 *     keySecret: Redacted.make("..."),
 *     organizationId: "...",
 *   }),
 * )
 * ```
 */
export const fromApiKey = (input: {
  keyId: string;
  keySecret: string | Redacted.Redacted<string>;
  organizationId?: string;
  apiBaseUrl?: string;
}) =>
  Effect.succeed<ClickHouseCloudResolvedCredentials>({
    type: "apiKey",
    keyId: input.keyId,
    keySecret:
      typeof input.keySecret === "string" ? Redacted.make(input.keySecret) : input.keySecret,
    organizationId: input.organizationId,
    apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    source: { type: "stored" },
  }).pipe(make, Layer.effectContext);

/**
 * Build ClickHouse Cloud `Credentials` + `OrganizationId` that resolve
 * through the Alchemy AuthProvider: environment credentials
 * (`CLICKHOUSE_CLOUD_API_KEY_ID` / `CLICKHOUSE_CLOUD_API_KEY_SECRET`) when
 * present, otherwise the selected profile. Resolution is deferred until the
 * first API call, so building the provider layers never needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effectContext(
    lazyCredentials<ClickHouseCloudResolvedCredentials, ConfigError>()(
      CLICKHOUSE_CLOUD_AUTH_PROVIDER_NAME,
      (creds) => creds,
    ).pipe(Effect.flatMap(make)),
  );
