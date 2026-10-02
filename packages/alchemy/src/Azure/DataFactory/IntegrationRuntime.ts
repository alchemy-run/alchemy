import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createHyphenName, definitionDiffers } from "./FactoryChild.ts";

export type IntegrationRuntimeType = "Managed" | "SelfHosted";

export interface IntegrationRuntimeProps {
  /** Resource group of the factory. Changing it replaces the integration runtime. */
  resourceGroup: string;
  /** Name of the factory that holds the integration runtime. Changing it replaces the integration runtime. */
  factoryName: string;
  /**
   * Integration runtime name: 3-63 letters, digits, and single hyphens,
   * starting and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * integration runtime.
   */
  name?: string;
  /**
   * `Managed` (an Azure or Azure-SSIS integration runtime hosted by Data
   * Factory) or `SelfHosted` (agents you install on your own machines).
   * Changing it replaces the integration runtime.
   */
  type: IntegrationRuntimeType;
  /**
   * Type-specific properties. `Managed`: `computeProperties` (`location`,
   * e.g. `"AutoResolve"`, `dataFlowProperties`, SSIS node size/count),
   * `ssisProperties`, `customerVirtualNetwork`. `SelfHosted`: `linkedInfo`
   * (shared runtime) and `selfContainedInteractiveAuthoringEnabled`.
   */
  typeProperties?: Record<string, unknown>;
  /**
   * Name of the factory's managed virtual network (always `default`) to
   * run a `Managed` integration runtime in. Changing it replaces the
   * integration runtime.
   */
  managedVirtualNetwork?: string;
  /**
   * Integration runtime description. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because integration runtimes have
   * no tags or annotations.
   */
  description?: string;
}

export interface IntegrationRuntime extends Resource<
  "Azure.DataFactory.IntegrationRuntime",
  IntegrationRuntimeProps,
  {
    /** Name of the integration runtime. */
    integrationRuntimeName: string;
    /** Name of the factory that holds the integration runtime. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the integration runtime. */
    integrationRuntimeId: string;
    /** Integration runtime type. */
    type: string;
    /** Managed virtual network the runtime runs in, if any. */
    managedVirtualNetwork: string | undefined;
    /**
     * Runtime state, e.g. `Online`, `Started`, `Stopped`,
     * `NeedRegistration` (a self-hosted runtime with no node yet).
     */
    state: string | undefined;
    /** Description without the Alchemy ownership marker. */
    description: string | undefined;
    /** Entity tag of the current definition. */
    etag: string | undefined;
    /**
     * Primary key used to register a self-hosted integration runtime node.
     * `undefined` for `Managed` runtimes.
     */
    authKey1: Redacted.Redacted<string> | undefined;
    /** Secondary registration key of a self-hosted integration runtime. */
    authKey2: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A Data Factory integration runtime — the compute that runs activities
 * and data flows: a managed Azure runtime (optionally inside the factory's
 * managed virtual network), an Azure-SSIS runtime, or a self-hosted runtime
 * whose nodes you register with the `authKey1`/`authKey2` attributes.
 *
 * Azure and self-hosted runtimes cost nothing while idle. Azure-SSIS
 * runtimes bill per node-hour while started; Alchemy stops a started SSIS
 * runtime before updating or deleting it.
 *
 * @see https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime
 *
 * ### Managed Runtimes
 * **Example:** Azure runtime with a data flow time-to-live
 * ```typescript
 * const runtime = yield* Azure.DataFactory.IntegrationRuntime("flows", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "Managed",
 *   typeProperties: {
 *     computeProperties: {
 *       location: "AutoResolve",
 *       dataFlowProperties: { computeType: "General", coreCount: 8, timeToLive: 10 },
 *     },
 *   },
 * });
 * ```
 *
 * ### Self-Hosted Runtimes
 * **Example:** Self-hosted runtime and its registration key
 * ```typescript
 * const onPrem = yield* Azure.DataFactory.IntegrationRuntime("on-prem", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   type: "SelfHosted",
 * });
 * // Pass onPrem.authKey1 to the self-hosted IR installer on your machine.
 * ```
 *
 * @resource
 */
export const IntegrationRuntime = Resource<IntegrationRuntime>(
  "Azure.DataFactory.IntegrationRuntime",
);

export class IntegrationRuntimeStateTimedOut extends Data.TaggedError(
  "Azure.DataFactory.IntegrationRuntimeStateTimedOut",
)<{
  readonly integrationRuntime: string;
  readonly state: string | undefined;
  readonly message: string;
}> {}

const MARKER = /\s*\[alchemy ([^\]]+)\]$/;

const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

const descriptionWithMarker = (
  description: string | undefined,
  marker: string,
) => (description ? `${description} ${marker}` : marker);

const stripMarker = (description: string | undefined) => {
  const stripped = description?.replace(MARKER, "");
  return stripped ? stripped : undefined;
};

type Where = {
  subscriptionId: string;
  resourceGroupName: string;
  factoryName: string;
  integrationRuntimeName: string;
};

const getRuntime = (where: Where) =>
  orUndefinedIfNotFound(datafactory.GetIntegrationRuntime(where));

const getState = (where: Where) =>
  orUndefinedIfNotFound(datafactory.GetIntegrationRuntimeStatus(where)).pipe(
    Effect.map((status) => status?.properties.state),
  );

const getAuthKeys = (where: Where, type: string) =>
  type === "SelfHosted"
    ? orUndefinedIfNotFound(datafactory.ListIntegrationRuntimeAuthKeys(where))
    : Effect.succeed(undefined);

const referenceNameOf = (reference: unknown) =>
  reference !== null &&
  typeof reference === "object" &&
  "referenceName" in reference &&
  typeof reference.referenceName === "string"
    ? reference.referenceName
    : undefined;

/** Poll the runtime status until it reaches `target` (SSIS start/stop). */
const waitForState = (where: Where, target: "Started" | "Stopped") =>
  getState(where).pipe(
    Effect.repeat({
      until: (state) => state === target,
      schedule: Schedule.spaced("30 seconds"),
      times: 60,
    }),
    Effect.flatMap((state) =>
      state === target
        ? Effect.void
        : Effect.fail(
            new IntegrationRuntimeStateTimedOut({
              integrationRuntime: where.integrationRuntimeName,
              state,
              message: `integration runtime ${where.integrationRuntimeName} did not reach '${target}' (last state: ${state ?? "not found"})`,
            }),
          ),
    ),
  );

const toAttrs = Effect.fn(function* (
  where: Where,
  observed: datafactory.GetIntegrationRuntimeResponse,
) {
  const state = yield* getState(where);
  const keys = yield* getAuthKeys(where, observed.properties.type);
  return {
    integrationRuntimeName: where.integrationRuntimeName,
    factoryName: where.factoryName,
    resourceGroup: where.resourceGroupName,
    integrationRuntimeId: observed.id ?? "",
    type: observed.properties.type,
    managedVirtualNetwork: referenceNameOf(
      observed.properties.managedVirtualNetwork,
    ),
    state,
    description: stripMarker(observed.properties.description),
    etag: observed.etag,
    authKey1: keys?.authKey1 ? Redacted.make(keys.authKey1) : undefined,
    authKey2: keys?.authKey2 ? Redacted.make(keys.authKey2) : undefined,
  } satisfies IntegrationRuntime["Attributes"];
});

export const IntegrationRuntimeProvider = () =>
  Provider.succeed(IntegrationRuntime, {
    stables: [
      "integrationRuntimeName",
      "factoryName",
      "resourceGroup",
      "integrationRuntimeId",
      "type",
    ],

    // Integration runtimes live inside a factory; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.integrationRuntimeName.toLowerCase()) ||
        news.type !== output.type ||
        (news.managedVirtualNetwork ?? "") !==
          (output.managedVirtualNetwork ?? "")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const factoryName = output?.factoryName ?? olds?.factoryName;
      if (resourceGroup === undefined || factoryName === undefined) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        factoryName,
        integrationRuntimeName:
          output?.integrationRuntimeName ??
          olds?.name ??
          (yield* createHyphenName(id)),
      };
      const observed = yield* getRuntime(where);
      if (observed === undefined) return undefined;
      const attrs = yield* toAttrs(where, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        factoryName: news.factoryName,
        integrationRuntimeName:
          news.name ??
          output?.integrationRuntimeName ??
          (yield* createHyphenName(id)),
      };
      const marker = yield* ownershipMarker(id);
      const desired = {
        type: news.type,
        typeProperties: news.typeProperties,
        managedVirtualNetwork: news.managedVirtualNetwork
          ? {
              type: "ManagedVirtualNetworkReference",
              referenceName: news.managedVirtualNetwork,
            }
          : undefined,
        description: descriptionWithMarker(news.description, marker),
      };

      // Observe.
      let observed = yield* getRuntime(where);

      // Ensure + sync with one synchronous full-definition PUT. A started
      // Azure-SSIS runtime must be stopped for the update and restarted.
      if (
        observed === undefined ||
        definitionDiffers(desired, observed.properties)
      ) {
        const wasStarted =
          observed !== undefined && (yield* getState(where)) === "Started";
        if (wasStarted) {
          yield* datafactory.StopIntegrationRuntime(where);
          yield* waitForState(where, "Stopped");
        }
        observed = yield* datafactory.IntegrationRuntimesCreateOrUpdate({
          ...where,
          properties: desired,
        });
        if (wasStarted) {
          yield* datafactory.StartIntegrationRuntime(where);
          yield* waitForState(where, "Started");
        }
      }

      return yield* toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        factoryName: output.factoryName,
        integrationRuntimeName: output.integrationRuntimeName,
      };
      // A started Azure-SSIS runtime cannot be deleted.
      if ((yield* getState(where)) === "Started") {
        yield* ignoreNotFound(datafactory.StopIntegrationRuntime(where));
        yield* waitForState(where, "Stopped");
      }
      yield* ignoreNotFound(datafactory.DeleteIntegrationRuntime(where));
      yield* waitUntilGone(
        `integration runtime ${output.integrationRuntimeName}`,
        getRuntime(where),
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
