import * as healthcareapis from "@distilled.cloud/azure/healthcareapis";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  covers,
  checkServiceId,
  createServiceName,
  type HealthcareIdentity,
  identityBody,
  sameArm,
  sameIdentity,
  SERVICE_BUDGET,
  whileNotTerminal,
  desiredMarkerTags,
  hasAnyMarker,
  markerTagsDiffer,
  ownsMarkerTags,
  userMarkerTags,
} from "./Common.ts";

export type FhirVersion = "fhir-R4" | "fhir-Stu3";
export type FhirResourceVersionPolicy = "no-version" | "versioned" | "versioned-update";

export interface HealthcareCorsConfiguration {
  /**
   * Origins allowed via CORS, e.g. `https://app.contoso.com` or `*`.
   * @default []
   */
  origins?: string[];
  /**
   * Request headers allowed via CORS.
   * @default []
   */
  headers?: string[];
  /**
   * HTTP methods allowed via CORS.
   * @default []
   */
  methods?: string[];
  /**
   * Seconds a browser may cache the preflight response.
   * @default unset (the browser's default)
   */
  maxAge?: number;
  /**
   * Whether credentials are allowed via CORS.
   * @default false
   */
  allowCredentials?: boolean;
}

export interface FhirSmartIdentityProviderApplication {
  /**
   * Application client ID in the identity provider.
   * @default unset
   */
  clientId?: string;
  /**
   * Audience used to validate bearer tokens against the authority.
   * @default unset
   */
  audience?: string;
  /**
   * Data actions the application may perform (`Read`).
   * @default []
   */
  allowedDataActions?: "Read"[];
}

export interface FhirSmartIdentityProvider {
  /**
   * Token-issuing authority of the identity provider.
   * @default unset
   */
  authority?: string;
  /**
   * Applications registered with the identity provider.
   * @default []
   */
  applications?: FhirSmartIdentityProviderApplication[];
}

export interface FhirAuthenticationConfiguration {
  /**
   * Token authority.
   * @default `https://login.microsoftonline.com/{tenantId}`
   */
  authority?: string;
  /**
   * Token audience.
   * @default the service URL
   */
  audience?: string;
  /**
   * Enable the SMART on FHIR proxy.
   * @default false
   */
  smartProxyEnabled?: boolean;
  /**
   * Third-party identity providers for SMART on FHIR authentication.
   * @default []
   */
  smartIdentityProviders?: FhirSmartIdentityProvider[];
}

export interface FhirOciArtifact {
  /**
   * Azure Container Registry login server.
   * @default unset
   */
  loginServer?: string;
  /**
   * Artifact (image) name.
   * @default unset
   */
  imageName?: string;
  /**
   * Artifact digest.
   * @default unset (the latest artifact)
   */
  digest?: string;
}

export interface FhirAcrConfiguration {
  /**
   * Login servers of Azure Container Registries holding custom templates.
   * @default []
   */
  loginServers?: string[];
  /**
   * OCI artifacts (e.g. `$convert-data` templates) to load.
   * @default []
   */
  ociArtifacts?: FhirOciArtifact[];
}

export interface FhirImportConfiguration {
  /**
   * Name of the storage account `$import` reads from.
   * @default unset
   */
  integrationDataStore?: string;
  /**
   * Put the service in initial import mode (bulk load into an empty service).
   * @default false
   */
  initialImportMode?: boolean;
  /**
   * Enable the `$import` operation.
   * @default false
   */
  enabled?: boolean;
}

export interface FhirResourceVersionPolicyConfiguration {
  /**
   * Default history tracking for all resource types.
   * @default "versioned"
   */
  default?: FhirResourceVersionPolicy;
  /**
   * Per resource type overrides, e.g. `{ Patient: "no-version" }`.
   * @default {}
   */
  resourceTypeOverrides?: Record<string, FhirResourceVersionPolicy>;
}

export interface FhirServiceProps {
  /**
   * Resource group of the workspace. Changing it replaces the service.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Health Data Services workspace. Required. Changing it
   * replaces the service.
   */
  workspace: string;
  /**
   * Service name: 3-24 lowercase letters and digits, starting with a
   * letter. The service's full ARM resource ID must be at most 253
   * characters: longer ones are accepted by ARM but end in provisioning
   * state `Failed`, so reconcile rejects them up front. Generated names
   * are shortened to fit. The service URL is
   * `https://{workspace}-{name}.fhir.azurehealthcareapis.com`. Changing it
   * replaces the service.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location; must be the workspace's location. Changing it replaces
   * the service.
   * @default the workspace's location
   */
  location?: string;
  /**
   * FHIR version. Changing it replaces the service.
   * @default "fhir-R4"
   */
  kind?: FhirVersion;
  /**
   * Managed identity, e.g. `{ type: "SystemAssigned" }` (required for
   * export/import and ACR access).
   * @default no identity
   */
  identity?: HealthcareIdentity;
  /**
   * Authentication settings for the data plane.
   * @default Entra ID tokens from your tenant, with the service URL as audience
   */
  authenticationConfiguration?: FhirAuthenticationConfiguration;
  /**
   * CORS settings for browser clients.
   * @default no CORS rules
   */
  corsConfiguration?: HealthcareCorsConfiguration;
  /**
   * Name of the storage account `$export` writes to. The service identity
   * needs `Storage Blob Data Contributor` on it.
   * @default unset (`$export` is disabled)
   */
  exportStorageAccountName?: string;
  /**
   * `$import` settings.
   * @default unset (`$import` is disabled)
   */
  importConfiguration?: FhirImportConfiguration;
  /**
   * Azure Container Registry settings for custom conversion templates.
   * @default no registries
   */
  acrConfiguration?: FhirAcrConfiguration;
  /**
   * History tracking (versioning) of FHIR resources.
   * @default Azure's default (`versioned` for every resource type)
   */
  resourceVersionPolicyConfiguration?: FhirResourceVersionPolicyConfiguration;
  /**
   * Enable the US Core "missing data" implementation guide requirement.
   * @default false
   */
  usCoreMissingData?: boolean;
  /**
   * Key Vault key URL for customer-managed key encryption. Chosen at
   * creation: changing it replaces the service.
   * @default Microsoft-managed keys
   */
  keyEncryptionKeyUrl?: string;
  /**
   * User tags. Alchemy ownership markers (`alchemy_stack`, `alchemy_stage`,
   * `alchemy_id`) are merged in automatically; this resource provider
   * rejects `:` in tag names.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface FhirService extends Resource<
  "Azure.HealthcareApis.FhirService",
  FhirServiceProps,
  {
    /** Name of the FHIR service (without the workspace prefix). */
    fhirServiceName: string;
    /** ARM resource ID of the FHIR service. */
    fhirServiceId: string;
    /** Name of the workspace that holds the service. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** FHIR version. */
    kind: string;
    /** FHIR endpoint, `https://{workspace}-{name}.fhir.azurehealthcareapis.com`. */
    serviceUrl: string;
    /** Token authority the service accepts. */
    authority: string | undefined;
    /** Token audience the service accepts. */
    audience: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Event Grid event support status. */
    eventState: string | undefined;
    /** Whether data-plane traffic from public networks is allowed. */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership markers stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A FHIR service in an Azure Health Data Services workspace
 * (`Microsoft.HealthcareApis/workspaces/fhirservices`): a managed,
 * standards-based FHIR R4 (or STU3) API for exchanging clinical data.
 * Billing is consumption based (storage and API calls); an empty service
 * costs next to nothing. Provisioning takes several minutes.
 *
 * @see https://learn.microsoft.com/azure/healthcare-apis/fhir/overview
 *
 * ### Creating a FHIR Service
 * **Example:** FHIR R4 service with Entra ID authentication
 * ```typescript
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace");
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   workspace: workspace.workspaceName,
 * });
 * // fhir.serviceUrl -> https://{workspace}-{name}.fhir.azurehealthcareapis.com
 * ```
 *
 * ### Browser Access
 * **Example:** FHIR service with CORS for a web app
 * ```typescript
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace");
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   workspace: workspace.workspaceName,
 *   corsConfiguration: {
 *     origins: ["https://app.contoso.com"],
 *     headers: ["*"],
 *     methods: ["GET", "POST", "PUT"],
 *     maxAge: 600,
 *   },
 * });
 * ```
 *
 * ### Bulk Export
 * **Example:** Managed identity and an export storage account
 * ```typescript
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace");
 * const account = yield* Azure.Storage.StorageAccount("exports");
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   workspace: workspace.workspaceName,
 *   identity: { type: "SystemAssigned" },
 *   exportStorageAccountName: account.storageAccountName,
 * });
 * // grant fhir.principalId "Storage Blob Data Contributor" on the account
 * ```
 *
 * :::caution
 * Changing `name`, `workspace`, `resourceGroup`, `location`, `kind`, or
 * `keyEncryptionKeyUrl` replaces the service and deletes its FHIR data.
 * :::
 *
 * :::caution
 * The service's full ARM resource ID must be at most 253 characters.
 * Reconcile fails with `Azure.HealthcareApis.ServiceIdTooLong` for longer
 * IDs: shorten the resource group, workspace, or service name.
 * :::
 *
 * @resource
 */
export const FhirService = GroupedResource<FhirService>("Azure.HealthcareApis.FhirService");

type ObservedFhir = healthcareapis.GetFhirServiceResponse | healthcareapis.FhirService;

const getFhir = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  fhirServiceName: string,
) =>
  orUndefinedIfNotFound(
    healthcareapis.GetFhirService({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      fhirServiceName,
    }),
  );

const serviceUrlOf = (workspace: string, name: string) =>
  `https://${workspace}-${name}.fhir.azurehealthcareapis.com`;

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  fhir: ObservedFhir,
): FhirService["Attributes"] => ({
  fhirServiceName: name,
  fhirServiceId: fhir.id ?? "",
  workspace,
  resourceGroup,
  location: fhir.location ?? "",
  kind: fhir.kind ?? "",
  serviceUrl: serviceUrlOf(workspace, name),
  authority: fhir.properties?.authenticationConfiguration?.authority,
  audience: fhir.properties?.authenticationConfiguration?.audience,
  principalId: fhir.identity?.principalId,
  eventState: fhir.properties?.eventState,
  publicNetworkAccess: fhir.properties?.publicNetworkAccess,
  tags: userMarkerTags(fhir.tags),
});

/** Configurable aspects, compared one by one against observed state. */
const aspects = (props: FhirServiceProps) => ({
  authenticationConfiguration: props.authenticationConfiguration,
  corsConfiguration: props.corsConfiguration,
  exportConfiguration:
    props.exportStorageAccountName === undefined
      ? undefined
      : { storageAccountName: props.exportStorageAccountName },
  importConfiguration: props.importConfiguration,
  acrConfiguration: props.acrConfiguration,
  resourceVersionPolicyConfiguration: props.resourceVersionPolicyConfiguration,
  implementationGuidesConfiguration:
    props.usCoreMissingData === undefined
      ? undefined
      : { usCoreMissingData: props.usCoreMissingData },
});

const lastSegment = (name: string | undefined) => name?.split("/").pop();

export const FhirServiceProvider = () =>
  Provider.succeed(FhirService, {
    stables: [
      "fhirServiceName",
      "fhirServiceId",
      "workspace",
      "resourceGroup",
      "location",
      "kind",
      "serviceUrl",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const workspaces = yield* collectAll(healthcareapis.ListWorkspaceBySubscription, {
        subscriptionId,
      });
      const found: FhirService["Attributes"][] = [];
      for (const workspace of workspaces.value ?? []) {
        const group = resourceGroupOf(workspace.id);
        if (group === undefined || workspace.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          collectAll(healthcareapis.ListFhirServiceByWorkspace, {
            subscriptionId,
            resourceGroupName: group,
            workspaceName: workspace.name,
          }),
        );
        for (const fhir of page?.value ?? []) {
          const name = lastSegment(fhir.name);
          if (hasAnyMarker(fhir.tags) && name !== undefined) {
            found.push(toAttrs(group, workspace.name, name, fhir));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && !sameArm(news.name, output.fhirServiceName)) ||
        (news.location !== undefined &&
          !sameArm(news.location.replace(/\s/g, ""), output.location.replace(/\s/g, ""))) ||
        !sameArm(news.kind ?? "fhir-R4", output.kind || "fhir-R4") ||
        news.keyEncryptionKeyUrl !== olds?.keyEncryptionKeyUrl
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.fhirServiceName ??
        olds?.name ??
        (yield* createServiceName(id, {
          subscriptionId,
          resourceGroup,
          workspace,
          collection: "fhirservices",
        }));
      const observed = yield* getFhir(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* ownsMarkerTags(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HealthcareApis");
      const { resourceGroup, workspace } = news;
      const scope = {
        subscriptionId,
        resourceGroup,
        workspace,
        collection: "fhirservices",
      } as const;
      const name = news.name ?? output?.fhirServiceName ?? (yield* createServiceName(id, scope));
      yield* checkServiceId(scope, name);
      const tags = yield* desiredMarkerTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        fhirServiceName: name,
      };
      const get = getFhir(subscriptionId, resourceGroup, workspace, name);
      const label = `FHIR service ${workspace}/${name}`;
      const serviceUrl = serviceUrlOf(workspace, name);
      const desired = aspects(news);

      // Observe.
      let observed = yield* get;

      // The full desired body; a PUT replaces every configurable aspect.
      const put = (location: string) =>
        healthcareapis.FhirServicesCreateOrUpdate({
          ...where,
          location,
          kind: news.kind ?? "fhir-R4",
          identity: identityBody(news.identity),
          tags,
          properties: {
            ...desired,
            authenticationConfiguration: {
              ...desired.authenticationConfiguration,
              authority:
                desired.authenticationConfiguration?.authority ??
                `https://login.microsoftonline.com/${env.tenantId}`,
              audience: desired.authenticationConfiguration?.audience ?? serviceUrl,
            },
            encryption:
              news.keyEncryptionKeyUrl === undefined
                ? undefined
                : {
                    customerManagedKeyEncryption: {
                      keyEncryptionKeyUrl: news.keyEncryptionKeyUrl,
                    },
                  },
          },
        });

      // Ensure. FHIR services live in their workspace's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* orUndefinedIfNotFound(
            healthcareapis.GetWorkspace({
              subscriptionId,
              resourceGroupName: resourceGroup,
              workspaceName: workspace,
            }),
          ))?.location ??
          env.location;
        yield* put(location).pipe(Effect.retry(whileNotTerminal));
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (fhir) => fhir.properties?.provisioningState,
        SERVICE_BUDGET,
      );

      // Sync configuration against observed state. An aspect the user set
      // before but removed now (olds hint) is cleared by the full PUT.
      const props: healthcareapis.FhirServiceProperties = observed.properties ?? {};
      const previous = olds === undefined ? undefined : aspects(olds);
      const configDrift = (Object.keys(desired) as (keyof typeof desired)[]).some(
        (key) =>
          !covers(desired[key], props[key]) ||
          (desired[key] === undefined && previous?.[key] !== undefined),
      );
      const identityDrift = !sameIdentity(news.identity, observed.identity);
      if (configDrift || identityDrift) {
        yield* put(observed.location ?? env.location).pipe(Effect.retry(whileNotTerminal));
        observed = yield* waitForProvisioned(
          label,
          get,
          (fhir) => fhir.properties?.provisioningState,
          SERVICE_BUDGET,
        );
      }

      // Sync tags against observed tags.
      if (markerTagsDiffer(observed.tags, tags)) {
        yield* healthcareapis
          .UpdateFhirService({ ...where, tags })
          .pipe(Effect.retry(whileNotTerminal));
        observed = yield* waitForProvisioned(
          label,
          get,
          (fhir) =>
            markerTagsDiffer(fhir.tags, tags) ? "Updating" : fhir.properties?.provisioningState,
          SERVICE_BUDGET,
        );
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        healthcareapis
          .DeleteFhirService({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            workspaceName: output.workspace,
            fhirServiceName: output.fhirServiceName,
          })
          .pipe(Effect.retry(whileNotTerminal)),
      );
      yield* waitUntilGone(
        `FHIR service ${output.workspace}/${output.fhirServiceName}`,
        getFhir(subscriptionId, output.resourceGroup, output.workspace, output.fhirServiceName),
        SERVICE_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.HealthcareApis.Workspace"],
    },
  });
