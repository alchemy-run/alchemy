import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { canonical, lower } from "./Common.ts";

/** A script run on the application's nodes. */
export interface ApplicationScriptAction {
  /** Name of the script action. */
  name: string;
  /** Publicly readable URI of the bash script. */
  uri: string;
  /** Parameters passed to the script. */
  parameters?: string;
  /**
   * Roles the script runs on.
   * @default ["edgenode"]
   */
  roles?: string[];
}

/** An HTTPS endpoint the gateway exposes for the application. */
export interface ApplicationHttpsEndpoint {
  /** Sub-domain suffix: the endpoint is `<cluster>-<suffix>.apps.azurehdinsight.net`. */
  subDomainSuffix: string;
  /** Port on the edge node the endpoint forwards to. */
  destinationPort: number;
  /**
   * Access modes of the endpoint.
   * @default ["WebPage"]
   */
  accessModes?: string[];
  /**
   * Skip the cluster gateway's basic authentication.
   * @default false
   */
  disableGatewayAuth?: boolean;
}

export interface ApplicationProps {
  /** Resource group of the cluster. Changing it replaces the application. */
  resourceGroup: string;
  /** Cluster the application is installed on. Changing it replaces the application. */
  cluster: string;
  /**
   * Application name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the application.
   */
  name?: string;
  /**
   * Virtual machine size of the edge node(s). Changing it replaces the
   * application.
   * @default "Standard_E4_v3"
   */
  edgeNodeVmSize?: string;
  /**
   * Number of edge nodes. Changing it replaces the application.
   * @default 1
   */
  edgeNodeCount?: number;
  /** Scripts that install the application. Changing them replaces the application. */
  installScriptActions: ApplicationScriptAction[];
  /** Scripts that run when the application is removed. Changing them replaces the application. */
  uninstallScriptActions?: ApplicationScriptAction[];
  /** HTTPS endpoints exposed through the cluster gateway. Changing them replaces the application. */
  httpsEndpoints?: ApplicationHttpsEndpoint[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "Azure.HDInsight.Application",
  ApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** ARM resource ID of the application. */
    applicationId: string;
    /** Cluster the application is installed on. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Application state, e.g. `Running`. */
    applicationState: string | undefined;
    /** Host names of the application's HTTPS endpoints. */
    httpsEndpoints: string[];
    /** Host names of the application's SSH endpoints. */
    sshEndpoints: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An HDInsight application — a custom application installed on dedicated
 * edge nodes of an HDInsight cluster by install script actions, optionally
 * exposed through the cluster gateway over HTTPS.
 *
 * Installing an application provisions new edge-node VMs (10-20 minutes)
 * that bill until the application is removed. Everything except tags is
 * fixed at creation; changes replace the application.
 *
 * @see https://learn.microsoft.com/azure/hdinsight/hdinsight-apps-install-custom-applications
 *
 * ### Installing an Application
 * **Example:** Edge node with an install script
 * ```typescript
 * const app = yield* Azure.HDInsight.Application("hue", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   installScriptActions: [
 *     {
 *       name: "install-hue",
 *       uri: "https://example.com/scripts/install-hue.sh",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Exposing an Endpoint
 * **Example:** Web UI behind the cluster gateway
 * ```typescript
 * const app = yield* Azure.HDInsight.Application("hue", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   edgeNodeVmSize: "Standard_E8_v3",
 *   installScriptActions: [
 *     { name: "install-hue", uri: "https://example.com/install-hue.sh" },
 *   ],
 *   httpsEndpoints: [{ subDomainSuffix: "hue", destinationPort: 8888 }],
 * });
 * ```
 *
 * @resource
 */
export const Application = Resource<Application>("Azure.HDInsight.Application");

type ObservedApplication = hdinsight.GetApplicationResponse;

const DEFAULT_VM_SIZE = "Standard_E4_v3";

const createApplicationName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  }))
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `a${name.slice(1)}`;
});

const getApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
) =>
  orUndefinedIfNotFound(
    hdinsight.GetApplication({
      subscriptionId,
      resourceGroupName,
      clusterName,
      applicationName,
    }),
  );

/** Ready once provisioning succeeded (`applicationState` follows it). */
const applicationStateOf = (app: ObservedApplication) =>
  app.properties?.provisioningState;

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  app: ObservedApplication,
): Application["Attributes"] => ({
  applicationName: name,
  applicationId: app.id ?? "",
  cluster,
  resourceGroup,
  applicationState: app.properties?.applicationState,
  httpsEndpoints: (app.properties?.httpsEndpoints ?? []).flatMap((e) =>
    e.location ? [e.location] : [],
  ),
  sshEndpoints: (app.properties?.sshEndpoints ?? []).flatMap((e) =>
    e.location ? [e.location] : [],
  ),
  tags: userTags(app.tags),
});

const scriptActions = (actions: ApplicationScriptAction[] | undefined) =>
  actions?.map((action) => ({
    name: action.name,
    uri: action.uri,
    parameters: action.parameters,
    roles: action.roles ?? ["edgenode"],
  }));

/** Everything fixed at creation; any change replaces the application. */
const immutableSignature = (props: ApplicationProps) =>
  canonical({
    edgeNodeVmSize: props.edgeNodeVmSize ?? DEFAULT_VM_SIZE,
    edgeNodeCount: props.edgeNodeCount ?? 1,
    install: scriptActions(props.installScriptActions),
    uninstall: scriptActions(props.uninstallScriptActions) ?? [],
    https: props.httpsEndpoints ?? [],
  });

const applicationProperties = (
  news: ApplicationProps,
): hdinsight.ApplicationPropertiesInput => ({
  applicationType: "CustomApplication",
  computeProfile: {
    roles: [
      {
        name: "edgenode",
        targetInstanceCount: news.edgeNodeCount ?? 1,
        hardwareProfile: { vmSize: news.edgeNodeVmSize ?? DEFAULT_VM_SIZE },
      },
    ],
  },
  installScriptActions: scriptActions(news.installScriptActions),
  uninstallScriptActions: scriptActions(news.uninstallScriptActions),
  httpsEndpoints: news.httpsEndpoints?.map((endpoint) => ({
    subDomainSuffix: endpoint.subDomainSuffix,
    destinationPort: endpoint.destinationPort,
    accessModes: endpoint.accessModes ?? ["WebPage"],
    disableGatewayAuth: endpoint.disableGatewayAuth ?? false,
  })),
  sshEndpoints: [],
});

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: ["applicationName", "applicationId", "cluster", "resourceGroup"],

    // Applications live on a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.applicationName.toLowerCase()) ||
        (olds !== undefined &&
          immutableSignature(news) !== immutableSignature(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.applicationName ??
        olds?.name ??
        (yield* createApplicationName(id));
      const observed = yield* getApplication(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HDInsight");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.applicationName ??
        (yield* createApplicationName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getApplication(subscriptionId, resourceGroup, cluster, name);
      // Edge nodes take 10-20 minutes to provision.
      const settle = waitForProvisioned(
        `HDInsight application ${name}`,
        get,
        applicationStateOf,
        { interval: "30 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync tags: the PUT is a long-running full upsert and the
      // only write the API offers, so it is re-sent only for a missing
      // application or a tag delta.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        yield* hdinsight.CreateApplication({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          applicationName: name,
          tags,
          properties: applicationProperties(news),
        });
      }
      observed = yield* settle;
      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hdinsight.DeleteApplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          applicationName: output.applicationName,
        }),
      );
      yield* waitUntilGone(
        `HDInsight application ${output.applicationName}`,
        getApplication(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.applicationName,
        ),
        { interval: "30 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.HDInsight.Cluster", "Azure.Resources.ResourceGroup"],
    },
  });
