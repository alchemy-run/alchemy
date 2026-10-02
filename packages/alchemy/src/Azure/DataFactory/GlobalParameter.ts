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
import { factoryOwnedByStack } from "./FactoryChild.ts";

export type GlobalParameterType =
  | "String"
  | "Int"
  | "Float"
  | "Bool"
  | "Array"
  | "Object";

export interface GlobalParameterValue {
  /** Parameter type. */
  type: GlobalParameterType;
  /** Parameter value, matching `type`. */
  value: unknown;
}

export interface GlobalParameterProps {
  /** Resource group of the factory. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the factory. Changing it replaces the resource. */
  factoryName: string;
  /**
   * Name of the global parameter set. Data Factory uses `default`.
   * Changing it replaces the resource.
   * @default "default"
   */
  name?: string;
  /**
   * Every global parameter of the factory, keyed by parameter name. The
   * map is written as a whole: parameters not listed here are removed.
   */
  parameters: Record<string, GlobalParameterValue>;
}

export interface GlobalParameter extends Resource<
  "Azure.DataFactory.GlobalParameter",
  GlobalParameterProps,
  {
    /** Name of the global parameter set (`default`). */
    globalParameterName: string;
    /** Name of the factory. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the global parameter set. */
    globalParameterId: string;
    /** Observed parameters, keyed by name. */
    parameters: Record<string, GlobalParameterValue>;
    /** Entity tag of the current definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The global parameters of a Data Factory — constants pipelines reference
 * as `@pipeline().globalParameters.<name>`. One resource owns the factory's
 * whole parameter map; do not also set global parameters on the factory.
 *
 * @see https://learn.microsoft.com/azure/data-factory/author-global-parameters
 *
 * ### Defining Global Parameters
 * **Example:** Environment name and batch size
 * ```typescript
 * yield* Azure.DataFactory.GlobalParameter("params", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   parameters: {
 *     env: { type: "String", value: "prod" },
 *     batchSize: { type: "Int", value: 500 },
 *   },
 * });
 * ```
 *
 * ### Structured Values
 * **Example:** Object and array parameters
 * ```typescript
 * yield* Azure.DataFactory.GlobalParameter("params", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   parameters: {
 *     endpoints: { type: "Array", value: ["a", "b"] },
 *     limits: { type: "Object", value: { maxRows: 1000 } },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const GlobalParameter = Resource<GlobalParameter>(
  "Azure.DataFactory.GlobalParameter",
);

const DEFAULT_NAME = "default";

const getGlobalParameter = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  globalParameterName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetGlobalParameter({
      subscriptionId,
      resourceGroupName,
      factoryName,
      globalParameterName,
    }),
  );

const toParameters = (
  map: { [key: string]: datafactory.GlobalParameterSpecification | undefined },
): Record<string, GlobalParameterValue> =>
  Object.fromEntries(
    Object.entries(map).flatMap(([key, spec]) =>
      spec === undefined
        ? []
        : [[key, { type: spec.type as GlobalParameterType, value: spec.value }]],
    ),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetGlobalParameterResponse,
): GlobalParameter["Attributes"] => ({
  globalParameterName: name,
  factoryName,
  resourceGroup,
  globalParameterId: observed.id ?? "",
  parameters: toParameters(observed.properties),
  etag: observed.etag,
});

/** Canonical JSON (sorted keys) for structural comparison. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

const parametersDiffer = (
  observed: Record<string, GlobalParameterValue>,
  desired: Record<string, GlobalParameterValue>,
) => {
  const keys = Object.keys(desired);
  if (keys.length !== Object.keys(observed).length) return true;
  return keys.some((key) => {
    const have = observed[key];
    const want = desired[key];
    return (
      have === undefined ||
      have.type.toLowerCase() !== want.type.toLowerCase() ||
      canonical(have.value) !== canonical(want.value)
    );
  });
};

export const GlobalParameterProvider = () =>
  Provider.succeed(GlobalParameter, {
    stables: [
      "globalParameterName",
      "factoryName",
      "resourceGroup",
      "globalParameterId",
    ],

    // Global parameters live inside a factory; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.name ?? DEFAULT_NAME).toLowerCase() !==
          output.globalParameterName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const factoryName = output?.factoryName ?? olds?.factoryName;
      if (resourceGroup === undefined || factoryName === undefined) {
        return undefined;
      }
      const name = output?.globalParameterName ?? olds?.name ?? DEFAULT_NAME;
      const observed = yield* getGlobalParameter(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, factoryName, name, observed);
      return (yield* factoryOwnedByStack(
        subscriptionId,
        resourceGroup,
        factoryName,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const { resourceGroup, factoryName } = news;
      const name = news.name ?? DEFAULT_NAME;

      // Observe.
      let observed = yield* getGlobalParameter(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );

      // Ensure + sync: one synchronous full-map PUT, skipped when the
      // observed map already matches.
      if (
        observed === undefined ||
        parametersDiffer(toParameters(observed.properties), news.parameters)
      ) {
        observed = yield* datafactory.GlobalParametersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          globalParameterName: name,
          properties: news.parameters,
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeleteGlobalParameter({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
          globalParameterName: output.globalParameterName,
        }),
      );
      yield* waitUntilGone(
        `global parameters ${output.globalParameterName}`,
        getGlobalParameter(
          subscriptionId,
          output.resourceGroup,
          output.factoryName,
          output.globalParameterName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
