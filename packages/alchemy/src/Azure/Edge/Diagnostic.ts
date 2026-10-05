import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
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
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface DiagnosticProps {
  /** Resource group the diagnostic is created in. Changing it replaces the diagnostic. */
  resourceGroup: string;
  /**
   * Name of the diagnostic. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the diagnostic.
   */
  name?: string;
  /**
   * Azure location of the diagnostic. Workload orchestration is available in
   * `eastus` and `eastus2`. Changing it replaces the diagnostic.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the custom location (`Microsoft.ExtendedLocation/customLocations`)
   * to collect diagnostics for. Changing it replaces the diagnostic.
   */
  customLocationId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Diagnostic extends Resource<
  "Azure.Edge.Diagnostic",
  DiagnosticProps,
  {
    /** Name of the diagnostic. */
    diagnosticName: string;
    /** Resource group that holds the diagnostic. */
    resourceGroup: string;
    /** ARM resource ID of the diagnostic. */
    diagnosticId: string;
    /** Location of the diagnostic. */
    location: string;
    /** Custom location the diagnostic runs on. */
    customLocationId: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration diagnostic. It collects workload
 * orchestration diagnostics for a custom location on an Arc-enabled
 * Kubernetes cluster.
 *
 * Requires an existing custom location (an Arc-enabled cluster with the
 * workload orchestration extension).
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Creating a Diagnostic
 * **Example:** Diagnostic for a custom location
 * ```typescript
 * const diagnostic = yield* Azure.Edge.Diagnostic("diag", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId:
 *     "/subscriptions/.../resourceGroups/arc/providers/Microsoft.ExtendedLocation/customLocations/plant",
 * });
 * ```
 *
 * @resource
 */
export const Diagnostic = Resource<Diagnostic>("Azure.Edge.Diagnostic");

const getDiagnostic = (
  subscriptionId: string,
  resourceGroupName: string,
  diagnosticName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetDiagnostic({ subscriptionId, resourceGroupName, diagnosticName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  diagnostic: edge.GetDiagnosticResponse,
): Diagnostic["Attributes"] => ({
  diagnosticName: name,
  resourceGroup,
  diagnosticId: diagnostic.id ?? "",
  location: diagnostic.location,
  customLocationId: diagnostic.extendedLocation?.name ?? "",
  tags: userTags(diagnostic.tags),
});

const diagnosticName = (id: string) =>
  createPhysicalName({ id, maxLength: 61 });

export const DiagnosticProvider = () =>
  Provider.succeed(Diagnostic, {
    stables: [
      "diagnosticName",
      "resourceGroup",
      "diagnosticId",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListDiagnosticBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDiagnosticBySubscription", page),
          ),
        );
      return page.value.flatMap((diagnostic) => {
        const group = resourceGroupOf(diagnostic.id);
        return hasAnyAlchemyTag(diagnostic.tags) &&
          group !== undefined &&
          diagnostic.name !== undefined
          ? [toAttrs(group, diagnostic.name, diagnostic)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.diagnosticName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        news.customLocationId.toLowerCase() !==
          output.customLocationId.toLowerCase()
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
        output?.diagnosticName ?? olds?.name ?? (yield* diagnosticName(id));
      const observed = yield* getDiagnostic(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.diagnosticName ?? (yield* diagnosticName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getDiagnostic(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync tags (the diagnostic's only mutable aspect).
      if (observed === undefined) {
        yield* edge.DiagnosticsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          diagnosticName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          extendedLocation: {
            name: news.customLocationId,
            type: "CustomLocation",
          },
          properties: {},
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* edge.UpdateDiagnostic({
          subscriptionId,
          resourceGroupName: resourceGroup,
          diagnosticName: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge diagnostic ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteDiagnostic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          diagnosticName: output.diagnosticName,
        }),
      );
      yield* waitUntilGone(
        `edge diagnostic ${output.diagnosticName}`,
        getDiagnostic(
          subscriptionId,
          output.resourceGroup,
          output.diagnosticName,
        ),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
