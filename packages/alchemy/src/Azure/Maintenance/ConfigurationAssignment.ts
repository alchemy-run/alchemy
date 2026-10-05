import * as maintenance from "@distilled.cloud/azure/maintenance";
import * as resourcegraph from "@distilled.cloud/azure/resourcegraph";
import * as resources from "@distilled.cloud/azure/resources";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  ListIncomplete,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Tag filter of a dynamic-scope assignment. */
export interface ConfigurationAssignmentTagSettings {
  /** Tag names mapped to the accepted values, e.g. `{ env: ["prod"] }`. */
  tags?: Record<string, string[]>;
  /**
   * Whether a resource must match `Any` or `All` of the tags.
   * @default "Any"
   */
  filterOperator?: "Any" | "All";
}

/**
 * Dynamic-scope filter selecting which resources under a subscription or
 * resource group the configuration applies to.
 */
export interface ConfigurationAssignmentFilter {
  /** Resource types, e.g. `["Microsoft.Compute/virtualMachines"]`. */
  resourceTypes?: string[];
  /** Resource group names (subscription scope only). */
  resourceGroups?: string[];
  /** Operating systems: `Windows`, `Linux`. */
  osTypes?: string[];
  /** Locations, e.g. `["eastus"]`. */
  locations?: string[];
  /** Tag filter. */
  tagSettings?: ConfigurationAssignmentTagSettings;
}

export interface ConfigurationAssignmentProps {
  /**
   * ARM ID the configuration is assigned to: a subscription
   * (`/subscriptions/{id}`), a resource group
   * (`/subscriptions/{id}/resourceGroups/{name}`), or a resource such as a
   * virtual machine or dedicated host (child resources such as a host in a
   * host group are supported). Subscription and resource-group scopes are
   * dynamic scopes and take a `filter`. Changing it replaces the
   * assignment.
   */
  scope: string;
  /**
   * ARM ID of the `Azure.Maintenance.MaintenanceConfiguration` to assign.
   * Changing it replaces the assignment.
   */
  maintenanceConfigurationId: string;
  /**
   * Name of the assignment. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the assignment.
   */
  name?: string;
  /**
   * Location of the assignment. It must match the target's location
   * (`global` for a subscription scope). Changing it replaces the
   * assignment.
   * @default `"global"` for a subscription scope, the resource group's location for a resource-group scope, else the `Azure.Location` layer location
   */
  location?: string;
  /**
   * Dynamic-scope filter (subscription and resource-group scopes only).
   */
  filter?: ConfigurationAssignmentFilter;
}

export interface ConfigurationAssignment extends Resource<
  "Azure.Maintenance.ConfigurationAssignment",
  ConfigurationAssignmentProps,
  {
    /** Name of the assignment. */
    configurationAssignmentName: string;
    /** ARM resource ID of the assignment. */
    configurationAssignmentId: string;
    /** ARM ID the configuration is assigned to. */
    scope: string;
    /** ARM ID of the assigned maintenance configuration. */
    maintenanceConfigurationId: string;
    /** Location of the assignment. */
    location: string;
    /** The observed dynamic-scope filter. */
    filter: ConfigurationAssignmentFilter | undefined;
  },
  never,
  Providers
> {}

/**
 * Assigns an `Azure.Maintenance.MaintenanceConfiguration` to a resource
 * (a VM, scale set, or dedicated host), or — as a dynamic scope — to every
 * resource in a subscription or resource group that matches a filter.
 *
 * Assignments cannot be tagged; Alchemy names them deterministically from
 * the stack, stage, and logical ID and gates adoption of an existing one.
 *
 * @see https://learn.microsoft.com/azure/update-manager/dynamic-scope-overview
 *
 * ### Dynamic Scopes
 * **Example:** Patch every tagged Linux VM in a resource group
 * ```typescript
 * yield* Azure.Maintenance.ConfigurationAssignment("linux-vms", {
 *   scope: group.resourceGroupId,
 *   maintenanceConfigurationId: patching.maintenanceConfigurationId,
 *   filter: {
 *     resourceTypes: ["Microsoft.Compute/virtualMachines"],
 *     osTypes: ["Linux"],
 *     tagSettings: { tags: { patch: ["nightly"] }, filterOperator: "Any" },
 *   },
 * });
 * ```
 *
 * ### Assigning a Single Resource
 * **Example:** Put one VM on a patch schedule
 * ```typescript
 * yield* Azure.Maintenance.ConfigurationAssignment("vm-patching", {
 *   scope: vm.virtualMachineId,
 *   maintenanceConfigurationId: patching.maintenanceConfigurationId,
 *   location: "eastus",
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationAssignment = Resource<ConfigurationAssignment>(
  "Azure.Maintenance.ConfigurationAssignment",
);

/** Where an assignment lives, parsed from its scope ARM ID. */
type Target =
  | { kind: "subscription"; subscriptionId: string }
  | {
      kind: "resourceGroup";
      subscriptionId: string;
      resourceGroupName: string;
    }
  | {
      kind: "resource";
      subscriptionId: string;
      resourceGroupName: string;
      providerName: string;
      resourceType: string;
      resourceName: string;
    }
  | {
      kind: "childResource";
      subscriptionId: string;
      resourceGroupName: string;
      providerName: string;
      resourceParentType: string;
      resourceParentName: string;
      resourceType: string;
      resourceName: string;
    };

export class InvalidAssignmentScope extends Data.TaggedError(
  "Azure.Maintenance.InvalidAssignmentScope",
)<{ readonly scope: string; readonly message: string }> {}

const parseScope = (scope: string): Target | undefined => {
  const parts = scope.split("/").filter((part) => part.length > 0);
  if (parts[0]?.toLowerCase() !== "subscriptions" || parts[1] === undefined) {
    return undefined;
  }
  const subscriptionId = parts[1];
  if (parts.length === 2) return { kind: "subscription", subscriptionId };
  if (parts[2]?.toLowerCase() !== "resourcegroups" || parts[3] === undefined) {
    return undefined;
  }
  const resourceGroupName = parts[3];
  if (parts.length === 4) {
    return { kind: "resourceGroup", subscriptionId, resourceGroupName };
  }
  if (parts[4]?.toLowerCase() !== "providers") return undefined;
  const providerName = parts[5];
  const rest = parts.slice(6);
  if (providerName === undefined) return undefined;
  if (rest.length === 2) {
    return {
      kind: "resource",
      subscriptionId,
      resourceGroupName,
      providerName,
      resourceType: rest[0]!,
      resourceName: rest[1]!,
    };
  }
  if (rest.length === 4) {
    return {
      kind: "childResource",
      subscriptionId,
      resourceGroupName,
      providerName,
      resourceParentType: rest[0]!,
      resourceParentName: rest[1]!,
      resourceType: rest[2]!,
      resourceName: rest[3]!,
    };
  }
  return undefined;
};

const targetOf = (scope: string) => {
  const target = parseScope(scope);
  return target === undefined
    ? Effect.fail(
        new InvalidAssignmentScope({
          scope,
          message: `'${scope}' is not a subscription, resource group, or resource ID`,
        }),
      )
    : Effect.succeed(target);
};

/** Request path parameters of a target (without the `kind` discriminator). */
const paramsOf = <T extends Target>({ kind: _kind, ...params }: T) => params;

const isDynamic = (target: Target) =>
  target.kind === "subscription" || target.kind === "resourceGroup";

/** The fields Alchemy reads from an assignment at any scope. */
interface ObservedAssignment {
  readonly id?: string;
  readonly location?: string;
  readonly properties?: maintenance.ConfigurationAssignmentProperties;
}

const asObserved = (
  assignment: ObservedAssignment | undefined,
): ObservedAssignment | undefined => assignment;

const getAssignment = (target: Target, configurationAssignmentName: string) => {
  switch (target.kind) {
    case "subscription":
      return orUndefinedIfNotFound(
        maintenance.GetConfigurationAssignmentsForSubscription({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      ).pipe(Effect.map(asObserved));
    case "resourceGroup":
      return orUndefinedIfNotFound(
        maintenance.GetConfigurationAssignmentsForResourceGroup({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      ).pipe(Effect.map(asObserved));
    case "resource":
      return orUndefinedIfNotFound(
        maintenance.GetConfigurationAssignment({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      ).pipe(Effect.map(asObserved));
    case "childResource":
      return orUndefinedIfNotFound(
        maintenance.GetConfigurationAssignmentParent({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      ).pipe(Effect.map(asObserved));
  }
};

const putAssignment = (
  target: Target,
  configurationAssignmentName: string,
  location: string,
  properties: maintenance.ConfigurationAssignmentProperties,
) => {
  const body = { configurationAssignmentName, location, properties };
  switch (target.kind) {
    case "subscription":
      return Effect.asVoid(
        maintenance.ConfigurationAssignmentsForSubscriptionsCreateOrUpdate({
          ...paramsOf(target),
          ...body,
        }),
      );
    case "resourceGroup":
      return Effect.asVoid(
        maintenance.ConfigurationAssignmentsForResourceGroupCreateOrUpdate({
          ...paramsOf(target),
          ...body,
        }),
      );
    case "resource":
      return Effect.asVoid(
        maintenance.ConfigurationAssignmentsCreateOrUpdate({
          ...paramsOf(target),
          ...body,
        }),
      );
    case "childResource":
      return Effect.asVoid(
        maintenance.ConfigurationAssignmentsCreateOrUpdateParent({
          ...paramsOf(target),
          ...body,
        }),
      );
  }
};

const deleteAssignment = (
  target: Target,
  configurationAssignmentName: string,
) => {
  switch (target.kind) {
    case "subscription":
      return ignoreNotFound(
        maintenance.DeleteConfigurationAssignmentsForSubscription({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      );
    case "resourceGroup":
      return ignoreNotFound(
        maintenance.DeleteConfigurationAssignmentsForResourceGroup({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      );
    case "resource":
      return ignoreNotFound(
        maintenance.DeleteConfigurationAssignment({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      );
    case "childResource":
      return ignoreNotFound(
        maintenance.DeleteConfigurationAssignmentParent({
          ...paramsOf(target),
          configurationAssignmentName,
        }),
      );
  }
};

const ASSIGNMENT_SEGMENT =
  /\/providers\/Microsoft\.Maintenance\/configurationAssignments\/[^/]+$/i;

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase().replace(/\/+$/, "") ===
  (b ?? "").toLowerCase().replace(/\/+$/, "");

const sameLocation = (a: string, b: string) =>
  a.toLowerCase().replaceAll(" ", "") === b.toLowerCase().replaceAll(" ", "");

const toFilter = (
  filter: maintenance.ConfigurationAssignmentFilterProperties | undefined,
): ConfigurationAssignmentFilter | undefined => {
  // The service returns `null` for unset filter fields.
  if (filter === undefined || filter === null) return undefined;
  const tags = filter.tagSettings?.tags ?? undefined;
  return {
    resourceTypes: filter.resourceTypes ?? undefined,
    resourceGroups: filter.resourceGroups ?? undefined,
    osTypes: filter.osTypes ?? undefined,
    locations: filter.locations ?? undefined,
    tagSettings:
      filter.tagSettings === undefined || filter.tagSettings === null
        ? undefined
        : {
            tags:
              tags === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(tags).map(([key, values]) => [
                      key,
                      values ?? [],
                    ]),
                  ),
            filterOperator: (filter.tagSettings.filterOperator ?? undefined) as
              | "Any"
              | "All"
              | undefined,
          },
  };
};

/** Canonical form of a filter for comparison (sorted, case-folded lists). */
const canonicalFilter = (filter: ConfigurationAssignmentFilter | undefined) => {
  const list = (values: string[] | null | undefined) =>
    values === undefined || values === null || values.length === 0
      ? undefined
      : [...values].map((v) => v.toLowerCase()).sort();
  const tags = filter?.tagSettings?.tags ?? undefined;
  return JSON.stringify({
    resourceTypes: list(filter?.resourceTypes),
    resourceGroups: list(filter?.resourceGroups),
    osTypes: list(filter?.osTypes),
    locations: list(filter?.locations?.map((l) => l.replaceAll(" ", ""))),
    tags:
      tags === undefined || Object.keys(tags).length === 0
        ? undefined
        : Object.keys(tags)
            .sort()
            .map((key) => [key, [...(tags[key] ?? [])].sort()]),
    filterOperator:
      tags === undefined || Object.keys(tags).length === 0
        ? undefined
        : (filter?.tagSettings?.filterOperator ?? "Any").toLowerCase(),
  });
};

const toAttrs = (
  scope: string,
  name: string,
  assignment: ObservedAssignment,
): ConfigurationAssignment["Attributes"] => ({
  configurationAssignmentName: name,
  configurationAssignmentId:
    assignment.id ??
    `${scope}/providers/Microsoft.Maintenance/configurationAssignments/${name}`,
  scope,
  maintenanceConfigurationId:
    assignment.properties?.maintenanceConfigurationId ?? "",
  location: assignment.location ?? "",
  filter: toFilter(assignment.properties?.filter),
});

/**
 * Generated name. The Maintenance RP fails resource IDs longer than ~256
 * characters, so the name shrinks as the scope ID grows.
 */
/** Rows of the Resource Graph `maintenanceresources` query in `list`. */
const GraphAssignments = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    location: Schema.optional(Schema.NullOr(Schema.String)),
    properties: Schema.optional(
      Schema.Struct({
        resourceId: Schema.optional(Schema.String),
        maintenanceConfigurationId: Schema.optional(Schema.String),
      }),
    ),
  }),
);

const assignmentName = (id: string, scope: string) =>
  createPhysicalName({
    id,
    maxLength: Math.max(16, Math.min(64, 195 - scope.length)),
  });

export const ConfigurationAssignmentProvider = () =>
  Provider.succeed(ConfigurationAssignment, {
    stables: [
      "configurationAssignmentName",
      "configurationAssignmentId",
      "scope",
      "maintenanceConfigurationId",
      "location",
    ],

    // Assignments carry no tags: an assignment is Alchemy-owned when it
    // points at an Alchemy-tagged maintenance configuration. The
    // subscription-wide list operation answers `NotImplemented`, so
    // assignments at every scope are found through Azure Resource Graph
    // (which reports IDs and names lowercased; ARM names are
    // case-insensitive, so they still address the assignment).
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const configs = yield* orUndefinedIfNotFound(
        maintenance.ListMaintenanceConfigurations({ subscriptionId }),
      );
      const owned = new Set(
        (configs?.value ?? []).flatMap((config) =>
          hasAnyAlchemyTag(config.tags) && config.id !== undefined
            ? [config.id.toLowerCase()]
            : [],
        ),
      );
      if (owned.size === 0) return [];
      const result = yield* resourcegraph.Resources({
        subscriptions: [subscriptionId],
        query:
          "maintenanceresources | where type =~ 'microsoft.maintenance/configurationassignments' | project id, name, location, properties",
      });
      if (result.resultTruncated === "true" || result._skipToken) {
        return yield* new ListIncomplete({
          operation: "maintenanceresources",
          message:
            "Resource Graph returned more than one page of configuration assignments; paging is not supported yet",
        });
      }
      const rows = yield* Schema.decodeUnknownEffect(GraphAssignments)(
        result.data,
      );
      return rows.flatMap((row) => {
        const configId =
          row.properties?.maintenanceConfigurationId?.toLowerCase();
        return configId !== undefined && owned.has(configId)
          ? [
              toAttrs(
                row.properties?.resourceId ??
                  row.id.replace(ASSIGNMENT_SEGMENT, ""),
                row.name,
                {
                  id: row.id,
                  location: row.location ?? undefined,
                  properties: {
                    maintenanceConfigurationId:
                      row.properties?.maintenanceConfigurationId,
                  },
                },
              ),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Scope and configuration IDs are stable upstream; an unresolved one
      // means its resource is being replaced.
      if (
        !("scope" in news) ||
        !isResolved(news.scope) ||
        !isResolved(news.maintenanceConfigurationId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<ConfigurationAssignmentProps>(news)) return undefined;
      if (
        !sameId(news.scope, output.scope) ||
        !sameId(
          news.maintenanceConfigurationId,
          output.maintenanceConfigurationId,
        ) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.configurationAssignmentName.toLowerCase()) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      if (scope === undefined) return undefined;
      const target = parseScope(scope);
      if (target === undefined) return undefined;
      const name =
        output?.configurationAssignmentName ??
        olds?.name ??
        (yield* assignmentName(id, scope));
      const observed = yield* getAssignment(target, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      // The name is derived from this stack/stage/id, but without state the
      // assignment may predate us, so adoption is gated.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const target = yield* targetOf(news.scope);
      yield* ensureRegistered(target.subscriptionId, "Microsoft.Maintenance");
      const name =
        news.name ??
        output?.configurationAssignmentName ??
        (yield* assignmentName(id, news.scope));
      // Subscription-scope assignments live in `global`; any other scope
      // must use its target's location.
      const location =
        news.location ??
        output?.location ??
        (target.kind === "subscription"
          ? "global"
          : target.kind === "resourceGroup"
            ? (yield* resources.GetResourceGroup(paramsOf(target))).location
            : env.location);
      const properties: maintenance.ConfigurationAssignmentProperties = {
        maintenanceConfigurationId: news.maintenanceConfigurationId,
        resourceId: isDynamic(target) ? undefined : news.scope,
        filter: news.filter,
      };

      // Observe.
      const observed = yield* getAssignment(target, name);

      // Ensure + sync: the PUT is a synchronous upsert of the whole body;
      // the filter is the only mutable aspect.
      if (
        observed === undefined ||
        !sameId(
          observed.properties?.maintenanceConfigurationId,
          news.maintenanceConfigurationId,
        ) ||
        canonicalFilter(toFilter(observed.properties?.filter)) !==
          canonicalFilter(news.filter)
      ) {
        yield* putAssignment(
          target,
          name,
          observed?.location ?? location,
          properties,
        );
      }

      const fresh = yield* waitForProvisioned(
        `configuration assignment ${name}`,
        getAssignment(target, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(news.scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const target = parseScope(output.scope);
      if (target === undefined) return;
      yield* deleteAssignment(target, output.configurationAssignmentName);
      yield* waitUntilGone(
        `configuration assignment ${output.configurationAssignmentName}`,
        getAssignment(target, output.configurationAssignmentName),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Maintenance.MaintenanceConfiguration",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
