import * as arcdata from "@distilled.cloud/azure/azurearcdata";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** The infrastructure an Arc data controller runs on. */
export type DataControllerInfrastructure =
  | "azure"
  | "gcp"
  | "aws"
  | "alibaba"
  | "onpremises"
  | "other";

/** Identity of the Kubernetes cluster an indirect-mode data controller runs in. */
export interface DataControllerOnPremiseProperty {
  /** Globally unique ID (GUID) identifying the Kubernetes cluster. */
  id: string;
  /** Certificate holding the cluster's public key, used to verify signed uploads. */
  publicSigningKey: string;
  /** Thumbprint of the signing certificate. */
  signingCertificateThumbprint?: string;
}

/** Username and password for a data controller login. */
export interface DataControllerLogin {
  /** Login username. */
  username: string;
  /** Login password. Write-only: Azure never returns it. */
  password: Redacted.Redacted<string>;
}

/** Log Analytics workspace the data controller uploads logs to. */
export interface DataControllerLogAnalyticsWorkspace {
  /** Workspace (customer) ID of the Log Analytics workspace. */
  workspaceId: string;
  /** Primary shared key of the workspace. Write-only. */
  primaryKey: Redacted.Redacted<string>;
}

/** The custom location of an Arc-enabled Kubernetes cluster. */
export interface DataControllerExtendedLocation {
  /** ARM ID of the custom location (`Microsoft.ExtendedLocation/customLocations`). */
  name: string;
  /**
   * Type of the extended location.
   * @default "CustomLocation"
   */
  type?: string;
}

export interface DataControllerProps {
  /**
   * Resource group the data controller is created in. Changing it replaces
   * the data controller.
   */
  resourceGroup: string;
  /**
   * Name of the data controller, 1-63 characters of lowercase letters,
   * digits and `-`. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the data controller.
   */
  name?: string;
  /**
   * Azure location of the data controller. Changing it replaces it.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Custom location of an Arc-enabled Kubernetes cluster with the
   * `microsoft.arcdataservices` extension (directly connected mode). Omit
   * it for indirect connectivity mode, where the cluster uploads usage via
   * `az arcdata`. Changing it replaces the data controller.
   */
  extendedLocation?: DataControllerExtendedLocation;
  /**
   * The infrastructure the data controller runs on.
   * @default "other"
   */
  infrastructure?: DataControllerInfrastructure;
  /**
   * Identity of the Kubernetes cluster for indirect connectivity mode.
   * Changing it replaces the data controller.
   */
  onPremiseProperty?: DataControllerOnPremiseProperty;
  /**
   * The raw Kubernetes `DataController` custom resource
   * (`apiVersion`, `kind`, `metadata`, `spec`) as exported from the
   * cluster. Azure requires it.
   */
  k8sRaw: Record<string, unknown>;
  /** Administrator login of the data controller. */
  basicLoginInformation?: DataControllerLogin;
  /** Login for the metrics (Grafana) dashboard. */
  metricsDashboardCredential?: DataControllerLogin;
  /** Login for the logs (Kibana) dashboard. */
  logsDashboardCredential?: DataControllerLogin;
  /** Log Analytics workspace the data controller uploads logs to. */
  logAnalyticsWorkspaceConfig?: DataControllerLogAnalyticsWorkspace;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DataController extends Resource<
  "Azure.ArcData.DataController",
  DataControllerProps,
  {
    /** Name of the data controller. */
    dataControllerName: string;
    /** Resource group that holds the data controller. */
    resourceGroup: string;
    /** ARM resource ID of the data controller. */
    dataControllerId: string;
    /** Location of the data controller. */
    location: string;
    /** ARM ID of the custom location, in directly connected mode. */
    extendedLocationName: string | undefined;
    /** The infrastructure the data controller runs on. */
    infrastructure: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** ARM ID of the connected cluster, in directly connected mode. */
    clusterId: string | undefined;
    /** ARM ID of the Arc data services extension, in directly connected mode. */
    extensionId: string | undefined;
    /** Last time the cluster uploaded data to Azure. */
    lastUploadedDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc data controller — the Azure projection of the Arc-enabled
 * data services control plane running in a Kubernetes cluster. SQL
 * Managed Instances and PostgreSQL servers on Arc hang off it.
 *
 * In indirect connectivity mode the resource is a registration that the
 * cluster uploads usage, metrics and logs to; in directly connected mode
 * it is bound to the custom location of an Arc-enabled Kubernetes cluster
 * running the `microsoft.arcdataservices` extension.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/data/overview
 *
 * ### Indirect Connectivity Mode
 * **Example:** Register an on-premises data controller
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("arc");
 * const controller = yield* Azure.ArcData.DataController("dc", {
 *   resourceGroup: group.resourceGroupName,
 *   infrastructure: "onpremises",
 *   onPremiseProperty: {
 *     id: "1c2c7f4a-5d55-4a1f-9c55-0e2b6c3b9a10",
 *     publicSigningKey: clusterSigningCertificate,
 *   },
 *   // The DataController custom resource exported by `az arcdata dc export`;
 *   // spec.settings.azure must name this subscription and resource group.
 *   k8sRaw: exportedDataControllerCr,
 * });
 * ```
 *
 * ### Directly Connected Mode
 * **Example:** Bind to an Arc-enabled Kubernetes custom location
 * ```typescript
 * const controller = yield* Azure.ArcData.DataController("dc", {
 *   resourceGroup: group.resourceGroupName,
 *   infrastructure: "azure",
 *   extendedLocation: { name: customLocationId },
 *   k8sRaw: dataControllerCr,
 *   basicLoginInformation: {
 *     username: "arcadmin",
 *     password: Redacted.make(adminPassword),
 *   },
 *   logAnalyticsWorkspaceConfig: {
 *     workspaceId: workspace.customerId,
 *     primaryKey: workspaceKey,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataController = Resource<DataController>(
  "Azure.ArcData.DataController",
);

type ObservedController = arcdata.GetDataControllerDataControllerResponse;

const getController = (
  subscriptionId: string,
  resourceGroupName: string,
  dataControllerName: string,
) =>
  orUndefinedIfNotFound(
    arcdata.GetDataControllerDataController({
      subscriptionId,
      resourceGroupName,
      dataControllerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  controller: ObservedController,
): DataController["Attributes"] => ({
  dataControllerName: name,
  resourceGroup,
  dataControllerId: controller.id ?? "",
  location: controller.location,
  extendedLocationName: controller.extendedLocation?.name,
  infrastructure: controller.properties?.infrastructure,
  provisioningState: controller.properties?.provisioningState,
  clusterId: controller.properties?.clusterId,
  extensionId: controller.properties?.extensionId,
  lastUploadedDate: controller.properties?.lastUploadedDate,
  tags: userTags(controller.tags),
});

const login = (value: DataControllerLogin | undefined) =>
  value === undefined
    ? undefined
    : { username: value.username, password: Redacted.value(value.password) };

const loginDiffers = (
  next: DataControllerLogin | undefined,
  prev: DataControllerLogin | undefined,
) =>
  next !== undefined &&
  (prev === undefined ||
    next.username !== prev.username ||
    Redacted.value(next.password) !== Redacted.value(prev.password));

const workspace = (value: DataControllerLogAnalyticsWorkspace | undefined) =>
  value === undefined
    ? undefined
    : {
        workspaceId: value.workspaceId,
        primaryKey: Redacted.value(value.primaryKey),
      };

/** Order-insensitive JSON for comparing raw Kubernetes specs. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true, delimiter: "-" });

export const DataControllerProvider = () =>
  Provider.succeed(DataController, {
    stables: [
      "dataControllerName",
      "resourceGroup",
      "dataControllerId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* arcdata
        .ListDataControllerInSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDataControllerInSubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((controller) => {
        const group = resourceGroupOf(controller.id);
        return hasAnyAlchemyTag(controller.tags) &&
          group !== undefined &&
          controller.name !== undefined
          ? [toAttrs(group, controller.name, controller)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.dataControllerName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        (news.extendedLocation?.name ?? "").toLowerCase() !==
          (output.extendedLocationName ?? "").toLowerCase() ||
        (olds !== undefined &&
          (news.onPremiseProperty?.id ?? "").toLowerCase() !==
            (olds.onPremiseProperty?.id ?? "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.dataControllerName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getController(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureArcData");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.dataControllerName ?? (yield* physicalName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const infrastructure = news.infrastructure ?? "other";
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dataControllerName: name,
      };
      const get = getController(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `Arc data controller ${name}`,
        get,
        (controller) => controller.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure: the PUT carries the full desired spec, including the
      // write-only credentials.
      if (observed === undefined) {
        yield* arcdata.PutDataControllerDataController({
          ...request,
          location,
          tags,
          extendedLocation:
            news.extendedLocation === undefined
              ? undefined
              : {
                  name: news.extendedLocation.name,
                  type: news.extendedLocation.type ?? "CustomLocation",
                },
          properties: {
            infrastructure,
            onPremiseProperty: news.onPremiseProperty,
            k8sRaw: news.k8sRaw,
            basicLoginInformation: login(news.basicLoginInformation),
            metricsDashboardCredential: login(news.metricsDashboardCredential),
            logsDashboardCredential: login(news.logsDashboardCredential),
            logAnalyticsWorkspaceConfig: workspace(
              news.logAnalyticsWorkspaceConfig,
            ),
          },
        });
        return toAttrs(resourceGroup, name, yield* settle);
      }

      // Sync: PATCH only the observed deltas. Credentials are write-only,
      // so they are compared against the previous props (all are sent on
      // adoption, when there are none).
      const props = observed.properties ?? {};
      const delta: arcdata.DataControllerPropertiesInput = {};
      if ((props.infrastructure ?? "") !== infrastructure) {
        delta.infrastructure = infrastructure;
      }
      if (
        news.onPremiseProperty !== undefined &&
        (props.onPremiseProperty?.publicSigningKey !==
          news.onPremiseProperty.publicSigningKey ||
          (news.onPremiseProperty.signingCertificateThumbprint !== undefined &&
            props.onPremiseProperty?.signingCertificateThumbprint !==
              news.onPremiseProperty.signingCertificateThumbprint))
      ) {
        delta.onPremiseProperty = news.onPremiseProperty;
      }
      if (canonical(props.k8sRaw) !== canonical(news.k8sRaw)) {
        delta.k8sRaw = news.k8sRaw;
      }
      if (
        loginDiffers(news.basicLoginInformation, olds?.basicLoginInformation)
      ) {
        delta.basicLoginInformation = login(news.basicLoginInformation);
      }
      if (
        loginDiffers(
          news.metricsDashboardCredential,
          olds?.metricsDashboardCredential,
        )
      ) {
        delta.metricsDashboardCredential = login(
          news.metricsDashboardCredential,
        );
      }
      if (
        loginDiffers(
          news.logsDashboardCredential,
          olds?.logsDashboardCredential,
        )
      ) {
        delta.logsDashboardCredential = login(news.logsDashboardCredential);
      }
      const nextWorkspace = news.logAnalyticsWorkspaceConfig;
      const prevWorkspace = olds?.logAnalyticsWorkspaceConfig;
      if (
        nextWorkspace !== undefined &&
        (props.logAnalyticsWorkspaceConfig?.workspaceId !==
          nextWorkspace.workspaceId ||
          prevWorkspace === undefined ||
          Redacted.value(prevWorkspace.primaryKey) !==
            Redacted.value(nextWorkspace.primaryKey))
      ) {
        delta.logAnalyticsWorkspaceConfig = workspace(nextWorkspace);
      }
      const propsChanged = Object.keys(delta).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* arcdata.PatchDataControllerDataController({
          ...request,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged ? delta : undefined,
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        arcdata.DeleteDataControllerDataController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dataControllerName: output.dataControllerName,
        }),
      );
      yield* waitUntilGone(
        `Arc data controller ${output.dataControllerName}`,
        getController(
          subscriptionId,
          output.resourceGroup,
          output.dataControllerName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
