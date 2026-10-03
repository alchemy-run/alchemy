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
import type { HealthcareCorsConfiguration } from "./FhirService.ts";

export interface DicomStorageConfiguration {
  /** ARM ID of a Data Lake Storage Gen2 account (hierarchical namespace enabled). */
  storageResourceId: string;
  /** File system (container) in the account that holds the DICOM data. */
  fileSystemName: string;
}

export interface DicomServiceProps {
  /** Resource group of the workspace. Changing it replaces the service. */
  resourceGroup: string;
  /** Name of the Health Data Services workspace. Changing it replaces the service. */
  workspace: string;
  /**
   * Service name: 3-24 lowercase letters and digits, starting with a
   * letter. The service URL is
   * `https://{workspace}-{name}.dicom.azurehealthcareapis.com`. If omitted,
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
   * Managed identity, e.g. `{ type: "SystemAssigned" }` (required for
   * external storage or customer-managed keys).
   */
  identity?: HealthcareIdentity;
  /** CORS settings for browser clients (e.g. DICOMweb viewers). */
  corsConfiguration?: HealthcareCorsConfiguration;
  /**
   * Store DICOM data in your own Data Lake Storage Gen2 account instead of
   * Microsoft-managed storage. Chosen at creation: changing it replaces the
   * service.
   */
  storageConfiguration?: DicomStorageConfiguration;
  /**
   * Enable data partitions. Can only be set at creation: changing it
   * replaces the service.
   * @default false
   */
  enableDataPartitions?: boolean;
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

export interface DicomService extends Resource<
  "Azure.HealthcareApis.DicomService",
  DicomServiceProps,
  {
    /** Name of the DICOM service (without the workspace prefix). */
    dicomServiceName: string;
    /** ARM resource ID of the DICOM service. */
    dicomServiceId: string;
    /** Name of the workspace that holds the service. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** DICOMweb endpoint, `https://{workspace}-{name}.dicom.azurehealthcareapis.com`. */
    serviceUrl: string;
    /** Token authority the service accepts. */
    authority: string | undefined;
    /** Token audiences the service accepts. */
    audiences: string[];
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Event Grid event support status. */
    eventState: string | undefined;
    /** Whether data partitions are enabled. */
    enableDataPartitions: boolean;
    /** User tags (Alchemy ownership markers stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DICOM service in an Azure Health Data Services workspace — a managed
 * DICOMweb API for storing, querying and retrieving medical imaging data.
 * Billing is consumption based (storage and API calls); an empty service
 * costs next to nothing. Provisioning takes a few minutes.
 *
 * @see https://learn.microsoft.com/azure/healthcare-apis/dicom/overview
 *
 * ### Creating a DICOM Service
 * **Example:** DICOM service in a workspace
 * ```typescript
 * const workspace = yield* Azure.HealthcareApis.Workspace("workspace", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const dicom = yield* Azure.HealthcareApis.DicomService("dicom", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * // dicom.serviceUrl -> https://{workspace}-{name}.dicom.azurehealthcareapis.com
 * ```
 *
 * ### Browser Viewers
 * **Example:** DICOM service with CORS for a web viewer
 * ```typescript
 * const dicom = yield* Azure.HealthcareApis.DicomService("dicom", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   corsConfiguration: {
 *     origins: ["https://viewer.contoso.com"],
 *     headers: ["*"],
 *     methods: ["GET"],
 *   },
 * });
 * ```
 *
 * ### External Storage
 * **Example:** DICOM data in your own Data Lake account
 * ```typescript
 * const dicom = yield* Azure.HealthcareApis.DicomService("dicom", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   identity: { type: "SystemAssigned" },
 *   storageConfiguration: {
 *     storageResourceId: lake.storageAccountId,
 *     fileSystemName: "dicom",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DicomService = Resource<DicomService>(
  "Azure.HealthcareApis.DicomService",
);

type ObservedDicom =
  | healthcareapis.GetDicomServiceResponse
  | healthcareapis.DicomService;

const getDicom = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  dicomServiceName: string,
) =>
  orUndefinedIfNotFound(
    healthcareapis.GetDicomService({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dicomServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  dicom: ObservedDicom,
): DicomService["Attributes"] => ({
  dicomServiceName: name,
  dicomServiceId: dicom.id ?? "",
  workspace,
  resourceGroup,
  location: dicom.location ?? "",
  serviceUrl:
    dicom.properties?.serviceUrl ??
    `https://${workspace}-${name}.dicom.azurehealthcareapis.com`,
  authority: dicom.properties?.authenticationConfiguration?.authority,
  audiences: [
    ...(dicom.properties?.authenticationConfiguration?.audiences ?? []),
  ],
  principalId: dicom.identity?.principalId,
  eventState: dicom.properties?.eventState,
  enableDataPartitions: dicom.properties?.enableDataPartitions ?? false,
  tags: userMarkerTags(dicom.tags),
});

const lastSegment = (name: string | undefined) => name?.split("/").pop();

export const DicomServiceProvider = () =>
  Provider.succeed(DicomService, {
    stables: [
      "dicomServiceName",
      "dicomServiceId",
      "workspace",
      "resourceGroup",
      "location",
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
      const found: DicomService["Attributes"][] = [];
      for (const workspace of workspaces.value ?? []) {
        const group = resourceGroupOf(workspace.id);
        if (group === undefined || workspace.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          healthcareapis.ListDicomServiceByWorkspace({
            subscriptionId,
            resourceGroupName: group,
            workspaceName: workspace.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListDicomServiceByWorkspace", page);
        }
        for (const dicom of page?.value ?? []) {
          const name = lastSegment(dicom.name);
          if (hasAnyMarker(dicom.tags) && name !== undefined) {
            found.push(toAttrs(group, workspace.name, name, dicom));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const storage = news.storageConfiguration;
      const oldStorage = olds?.storageConfiguration;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.dicomServiceName)) ||
        (news.location !== undefined &&
          !sameArm(
            news.location.replace(/\s/g, ""),
            output.location.replace(/\s/g, ""),
          )) ||
        (news.enableDataPartitions ?? false) !== output.enableDataPartitions ||
        news.keyEncryptionKeyUrl !== olds?.keyEncryptionKeyUrl ||
        !sameArm(storage?.storageResourceId, oldStorage?.storageResourceId) ||
        storage?.fileSystemName !== oldStorage?.fileSystemName
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
        output?.dicomServiceName ??
        olds?.name ??
        (yield* createHealthcareName(id));
      const observed = yield* getDicom(
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
        output?.dicomServiceName ??
        (yield* createHealthcareName(id));
      const tags = yield* desiredMarkerTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        dicomServiceName: name,
      };
      const get = getDicom(subscriptionId, resourceGroup, workspace, name);
      const label = `DICOM service ${workspace}/${name}`;

      // Observe.
      let observed = yield* get;

      // The full desired body; a PUT replaces every configurable aspect.
      const put = (location: string) =>
        healthcareapis.DicomServicesCreateOrUpdate({
          ...where,
          location,
          identity: identityBody(news.identity),
          tags,
          properties: {
            corsConfiguration: news.corsConfiguration,
            storageConfiguration: news.storageConfiguration,
            enableDataPartitions: news.enableDataPartitions,
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

      // Ensure. DICOM services live in their workspace's location.
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
        (dicom) => dicom.properties?.provisioningState,
        SERVICE_BUDGET,
      );

      // Sync CORS and identity against observed state. CORS removed since
      // the last deploy (olds hint) is cleared by the full PUT.
      const corsDrift =
        !covers(
          news.corsConfiguration,
          observed.properties?.corsConfiguration,
        ) ||
        (news.corsConfiguration === undefined &&
          olds?.corsConfiguration !== undefined);
      const identityDrift = !sameIdentity(news.identity, observed.identity);
      if (corsDrift || identityDrift) {
        yield* put(observed.location ?? env.location).pipe(
          Effect.retry(whileNotTerminal),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (dicom) => dicom.properties?.provisioningState,
          SERVICE_BUDGET,
        );
      }

      // Sync tags against observed tags.
      if (markerTagsDiffer(observed.tags, tags)) {
        yield* healthcareapis
          .UpdateDicomService({ ...where, tags })
          .pipe(Effect.retry(whileNotTerminal));
        observed = yield* waitForProvisioned(
          label,
          get,
          (dicom) =>
            markerTagsDiffer(dicom.tags, tags)
              ? "Updating"
              : dicom.properties?.provisioningState,
          SERVICE_BUDGET,
        );
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        healthcareapis
          .DeleteDicomService({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            workspaceName: output.workspace,
            dicomServiceName: output.dicomServiceName,
          })
          .pipe(Effect.retry(whileNotTerminal)),
      );
      yield* waitUntilGone(
        `DICOM service ${output.workspace}/${output.dicomServiceName}`,
        getDicom(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.dicomServiceName,
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
