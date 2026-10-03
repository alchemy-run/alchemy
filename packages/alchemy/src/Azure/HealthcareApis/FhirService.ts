import * as healthcareapis from "@distilled.cloud/azure/healthcareapis";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  covers,
  createHealthcareName,
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
export type FhirResourceVersionPolicy =
  | "no-version"
  | "versioned"
  | "versioned-update";

export interface HealthcareCorsConfiguration {
  /** Origins allowed via CORS, e.g. `https://app.contoso.com` or `*`. */
  origins?: string[];
  /** Request headers allowed via CORS. */
  headers?: string[];
  /** HTTP methods allowed via CORS. */
  methods?: string[];
  /** Seconds a browser may cache the preflight response. */
  maxAge?: number;
  /** Whether credentials are allowed via CORS. */
  allowCredentials?: boolean;
}

export interface FhirSmartIdentityProviderApplication {
  /** Application client ID in the identity provider. */
  clientId?: string;
  /** Audience used to validate bearer tokens against the authority. */
  audience?: string;
  /** Data actions the application may perform (`Read`). */
  allowedDataActions?: "Read"[];
}

export interface FhirSmartIdentityProvider {
  /** Token-issuing authority of the identity provider. */
  authority?: string;
  /** Applications registered with the identity provider. */
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
  /** Enable the SMART on FHIR proxy. */
  smartProxyEnabled?: boolean;
  /** Third-party identity providers for SMART on FHIR authentication. */
  smartIdentityProviders?: FhirSmartIdentityProvider[];
}

export interface FhirOciArtifact {
  /** Azure Container Registry login server. */
  loginServer?: string;
  /** Artifact (image) name. */
  imageName?: string;
  /** Artifact digest. */
  digest?: string;
}

export interface FhirAcrConfiguration {
  /** Login servers of Azure Container Registries holding custom templates. */
  loginServers?: string[];
  /** OCI artifacts (e.g. `$convert-data` templates) to load. */
  ociArtifacts?: FhirOciArtifact[];
}

export interface FhirImportConfiguration {
  /** Name of the storage account `$import` reads from. */
  integrationDataStore?: string;
  /** Put the service in initial import mode (bulk load into an empty service). */
  initialImportMode?: boolean;
  /** Enable the `$import` operation. */
  enabled?: boolean;
}

export interface FhirResourceVersionPolicyConfiguration {
  /** Default history tracking for all resource types. */
  default?: FhirResourceVersionPolicy;
  /** Per resource type overrides, e.g. `{ Patient: "no-version" }`. */
  resourceTypeOverrides?: Record<string, FhirResourceVersionPolicy>;
}

export interface FhirServiceProps {
  /**
   * Resource group of the workspace. Changing it replaces the service.
   */
  resourceGroup: string;
  /** Name of the Health Data Services workspace. Changing it replaces the service. */
  workspace: string;
  /**
   * Service name: 3-24 lowercase letters and digits, starting with a
   * letter. The service URL is
   * `https://{workspace}-{name}.fhir.azurehealthcareapis.com`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the service.
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
   */
  identity?: HealthcareIdentity;
  /** Authentication settings for the data plane. */
  authenticationConfiguration?: FhirAuthenticationConfiguration;
  /** CORS settings for browser clients. */
  corsConfiguration?: HealthcareCorsConfiguration;
  /**
   * Name of the storage account `$export` writes to. The service identity
   * needs `Storage Blob Data Contributor` on it.
   */
  exportStorageAccountName?: string;
  /** `$import` settings. */
  importConfiguration?: FhirImportConfiguration;
  /** Azure Container Registry settings for custom conversion templates. */
  acrConfiguration?: FhirAcrConfiguration;
  /** History tracking (versioning) of FHIR resources. */
  resourceVersionPolicyConfiguration?: FhirResourceVersionPolicyConfiguration;
  /** Enable the US Core "missing data" implementation guide requirement. */
  usCoreMissingData?: boolean;
  /**
   * Key Vault key URL for customer-managed key encryption. Chosen at
   * creation: changing it replaces the service.
   */
  keyEncryptionKeyUrl?: string;
  /**
   * User tags. Alchemy ownership markers (`alchemy_stack`, `alchemy_stage`,
   * `alchemy_id`) are merged in automatically; this resource provider
   * rejects `:` in tag names.
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
 * A FHIR service in an Azure Health Data Services workspace — a managed,
 * standards-based FHIR R4 (or STU3) API for exchanging clinical data.
 * Billing is consumption based (storage and API calls); an empty service
 * costs next to nothing. Provisioning takes several minutes.
 *
 * @see https://learn.microsoft.com/azure/healthcare-apis/fhir/overview
 *
 * ### Creating a FHIR Service
 * **Example:** FHIR R4 service with Entra ID authentication
 * ```typescript
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * // fhir.serviceUrl -> https://{workspace}-{name}.fhir.azurehealthcareapis.com
 * ```
 *
 * ### Browser Access
 * **Example:** FHIR service with CORS for a web app
 * ```typescript
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   resourceGroup: group.resourceGroupName,
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
 * const fhir = yield* Azure.HealthcareApis.FhirService("fhir", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   identity: { type: "SystemAssigned" },
 *   exportStorageAccountName: account.storageAccountName,
 * });
 * ```
 *
 * @resource
 */
export const FhirService = Resource<FhirService>(
  "Azure.HealthcareApis.FhirService",
);

type ObservedFhir =
  | healthcareapis.GetFhirServiceResponse
  | healthcareapis.FhirService;

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
      const workspaces = yield* healthcareapis
        .ListWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkspaceBySubscription", page),
          ),
        );
      const found: FhirService["Attributes"][] = [];
      for (const workspace of workspaces.value ?? []) {
        const group = resourceGroupOf(workspace.id);
        if (group === undefined || workspace.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          healthcareapis.ListFhirServiceByWorkspace({
            subscriptionId,
            resourceGroupName: group,
            workspaceName: workspace.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListFhirServiceByWorkspace", page);
        }
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
        (news.name !== undefined &&
          !sameArm(news.name, output.fhirServiceName)) ||
        (news.location !== undefined &&
          !sameArm(
            news.location.replace(/\s/g, ""),
            output.location.replace(/\s/g, ""),
          )) ||
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
        (yield* createHealthcareName(id));
      const observed = yield* getFhir(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* ownsMarkerTags(id, observed.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HealthcareApis");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.fhirServiceName ??
        (yield* createHealthcareName(id));
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
              audience:
                desired.authenticationConfiguration?.audience ?? serviceUrl,
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
      const props: healthcareapis.FhirServiceProperties =
        observed.properties ?? {};
      const previous = olds === undefined ? undefined : aspects(olds);
      const configDrift = (
        Object.keys(desired) as (keyof typeof desired)[]
      ).some(
        (key) =>
          !covers(desired[key], props[key]) ||
          (desired[key] === undefined && previous?.[key] !== undefined),
      );
      const identityDrift = !sameIdentity(news.identity, observed.identity);
      if (configDrift || identityDrift) {
        yield* put(observed.location ?? env.location).pipe(
          Effect.retry(whileNotTerminal),
        );
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
            markerTagsDiffer(fhir.tags, tags)
              ? "Updating"
              : fhir.properties?.provisioningState,
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
        getFhir(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.fhirServiceName,
        ),
        SERVICE_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HealthcareApis.Workspace",
      ],
    },
  });
