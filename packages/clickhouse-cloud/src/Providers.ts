import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiKey, ApiKeyProvider } from "./ApiKeys/ApiKey.ts";
import { ClickHouseCloudAuth } from "./AuthProvider.ts";
import { BackupConfiguration, BackupConfigurationProvider } from "./Backup/BackupConfiguration.ts";
import * as Credentials from "./Credentials.ts";
import { Organization, OrganizationProvider } from "./Organization/Organization.ts";
import { PreviewFeature, PreviewFeatureProvider } from "./Organization/PreviewFeature.ts";
import { Role, RoleProvider } from "./RoleManagement/Role.ts";
import { Service, ServiceProvider } from "./Service/Service.ts";

/**
 * Service tag bundling all ClickHouse Cloud providers + auth + credentials.
 * Use `ClickHouseCloud.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("ClickHouseCloud") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete ClickHouse Cloud providers Layer: every resource, the
 * AuthProvider registration (so `alchemy profile edit` can configure it),
 * and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: ClickHouseCloud.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([ApiKey, BackupConfiguration, Organization, PreviewFeature, Role, Service]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiKeyProvider(),
        BackupConfigurationProvider(),
        OrganizationProvider(),
        PreviewFeatureProvider(),
        RoleProvider(),
        ServiceProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ClickHouseCloudAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
