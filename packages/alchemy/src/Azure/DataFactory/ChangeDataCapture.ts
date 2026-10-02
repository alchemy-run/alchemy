import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  definitionDiffers,
  descriptionMarker,
  descriptionWithMarker,
  stripDescriptionMarker,
} from "./FactoryChild.ts";

export type ChangeDataCaptureSourceConnection =
  datafactory.MapperSourceConnectionsInfo;
export type ChangeDataCaptureTargetConnection =
  datafactory.MapperTargetConnectionsInfo;

export interface ChangeDataCapturePolicy {
  /** Run mode, e.g. `Microbatch` (batch) or `Realtime` (continuous). */
  mode: string;
  /** Batch frequency (`Microbatch` mode). */
  recurrence?: {
    /** Unit of the interval. */
    frequency: "Hour" | "Minute" | "Second";
    /** Number of `frequency` units between batches. */
    interval: number;
  };
}

export interface ChangeDataCaptureProps {
  /** Resource group of the factory. Changing it replaces the CDC. */
  resourceGroup: string;
  /** Name of the factory. Changing it replaces the CDC. */
  factoryName: string;
  /**
   * CDC name: letters, digits, and `_`, at most 127 characters. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the CDC.
   */
  name?: string;
  /**
   * Source connections (linked service + source tables) the CDC reads
   * changes from.
   */
  sourceConnectionsInfo: ChangeDataCaptureSourceConnection[];
  /**
   * Target connections (linked service + target tables + table/column
   * mappings) the CDC writes changes to.
   */
  targetConnectionsInfo: ChangeDataCaptureTargetConnection[];
  /** Run policy (mode and batch recurrence). */
  policy: ChangeDataCapturePolicy;
  /** Whether the CDC may override the factory's VNet configuration. */
  allowVNetOverride?: boolean;
  /** Folder shown in the authoring UI. */
  folder?: string;
  /**
   * CDC description. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`).
   */
  description?: string;
  /**
   * Whether the CDC should be running. A running CDC bills a data flow
   * cluster continuously; it is stopped before definition updates and
   * restarted afterwards.
   * @default false
   */
  started?: boolean;
}

export interface ChangeDataCapture extends Resource<
  "Azure.DataFactory.ChangeDataCapture",
  ChangeDataCaptureProps,
  {
    /** Name of the CDC. */
    changeDataCaptureName: string;
    /** Name of the factory. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the CDC. */
    changeDataCaptureId: string;
    /** Run status reported by Data Factory (e.g. `Running`, `Stopped`). */
    status: string | undefined;
    /** Description without the Alchemy ownership marker. */
    description: string | undefined;
    /** Entity tag of the current definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Data Factory change data capture (CDC) resource — a continuously or
 * micro-batch running process that copies changed rows from source tables
 * to target tables without pipelines.
 *
 * Defining a CDC is free; a running CDC bills a data flow cluster. Leave
 * `started` unset to manage only the definition.
 *
 * @see https://learn.microsoft.com/azure/data-factory/concepts-change-data-capture-resource
 *
 * ### Defining a CDC
 * **Example:** Micro-batch CDC between two linked services
 * ```typescript
 * yield* Azure.DataFactory.ChangeDataCapture("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   sourceConnectionsInfo: [{
 *     sourceEntities: [{ name: "dbo.orders" }],
 *     connection: {
 *       type: "linkedservicetype",
 *       linkedService: {
 *         referenceName: sql.linkedServiceName,
 *         type: "LinkedServiceReference",
 *       },
 *       linkedServiceType: "AzureSqlDatabase",
 *       isInlineDataset: true,
 *     },
 *   }],
 *   targetConnectionsInfo: [{
 *     targetEntities: [{ name: "orders" }],
 *     connection: {
 *       type: "linkedservicetype",
 *       linkedService: {
 *         referenceName: lake.linkedServiceName,
 *         type: "LinkedServiceReference",
 *       },
 *       linkedServiceType: "AzureBlobFS",
 *       isInlineDataset: true,
 *     },
 *   }],
 *   policy: { mode: "Microbatch", recurrence: { frequency: "Minute", interval: 15 } },
 * });
 * ```
 *
 * ### Running a CDC
 * **Example:** Start the CDC after deployment
 * ```typescript
 * yield* Azure.DataFactory.ChangeDataCapture("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   sourceConnectionsInfo,
 *   targetConnectionsInfo,
 *   policy: { mode: "Microbatch", recurrence: { frequency: "Hour", interval: 1 } },
 *   started: true,
 * });
 * ```
 *
 * @resource
 */
export const ChangeDataCapture = Resource<ChangeDataCapture>(
  "Azure.DataFactory.ChangeDataCapture",
);

const createCdcName = Effect.fn(function* (id: string) {
  const name = yield* createChildName(id);
  return name.slice(0, 127);
});

type Where = {
  subscriptionId: string;
  resourceGroupName: string;
  factoryName: string;
  changeDataCaptureName: string;
};

const getCdc = (where: Where) =>
  orUndefinedIfNotFound(datafactory.GetChangeDataCapture(where));

const isRunning = (status: string | undefined) =>
  (status ?? "").toLowerCase() === "running";

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetChangeDataCaptureResponse,
): ChangeDataCapture["Attributes"] => ({
  changeDataCaptureName: name,
  factoryName,
  resourceGroup,
  changeDataCaptureId: observed.id ?? "",
  status: observed.properties.status,
  description: stripDescriptionMarker(observed.properties.description),
  etag: observed.etag,
});

export const ChangeDataCaptureProvider = () =>
  Provider.succeed(ChangeDataCapture, {
    stables: [
      "changeDataCaptureName",
      "factoryName",
      "resourceGroup",
      "changeDataCaptureId",
    ],

    // CDCs live inside a factory; nuke removes them with it.
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
            output.changeDataCaptureName.toLowerCase())
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
      const name =
        output?.changeDataCaptureName ??
        olds?.name ??
        (yield* createCdcName(id));
      const observed = yield* getCdc({
        subscriptionId,
        resourceGroupName: resourceGroup,
        factoryName,
        changeDataCaptureName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, factoryName, name, observed);
      const marker = yield* descriptionMarker(id);
      return (observed.properties.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const { resourceGroup, factoryName } = news;
      const name =
        news.name ??
        output?.changeDataCaptureName ??
        (yield* createCdcName(id));
      const where: Where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        factoryName,
        changeDataCaptureName: name,
      };
      const marker = yield* descriptionMarker(id);
      const desired: datafactory.ChangeDataCapture = {
        sourceConnectionsInfo: news.sourceConnectionsInfo,
        targetConnectionsInfo: news.targetConnectionsInfo,
        policy: news.policy,
        allowVNetOverride: news.allowVNetOverride,
        folder: news.folder !== undefined ? { name: news.folder } : undefined,
        description: descriptionWithMarker(news.description, marker),
      };

      // Observe.
      let observed = yield* getCdc(where);

      // Ensure + sync the definition. A running CDC is stopped first.
      if (
        observed === undefined ||
        // Unset optional fields come back with server defaults
        // (`allowVNetOverride: false`), so only defined fields are compared.
        definitionDiffers(
          Object.fromEntries(
            Object.entries(desired).filter(([, v]) => v !== undefined),
          ),
          observed.properties,
        )
      ) {
        if (observed !== undefined && isRunning(observed.properties.status)) {
          yield* datafactory.StopChangeDataCapture(where);
        }
        observed = yield* datafactory.ChangeDataCaptureCreateOrUpdate({
          ...where,
          properties: desired,
        });
        observed = (yield* getCdc(where)) ?? observed;
      }

      // Sync the run state.
      const wantRunning = news.started === true;
      if (wantRunning !== isRunning(observed.properties.status)) {
        if (wantRunning) {
          yield* datafactory.StartChangeDataCapture(where);
        } else {
          yield* datafactory.StopChangeDataCapture(where);
        }
        observed = (yield* getCdc(where)) ?? observed;
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        factoryName: output.factoryName,
        changeDataCaptureName: output.changeDataCaptureName,
      };
      const observed = yield* getCdc(where);
      if (observed !== undefined && isRunning(observed.properties.status)) {
        yield* ignoreNotFound(datafactory.StopChangeDataCapture(where));
      }
      yield* ignoreNotFound(datafactory.DeleteChangeDataCapture(where));
      yield* waitUntilGone(
        `change data capture ${output.changeDataCaptureName}`,
        getCdc(where),
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
