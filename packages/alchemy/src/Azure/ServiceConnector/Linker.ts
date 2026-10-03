import * as servicelinker from "@distilled.cloud/azure/servicelinker";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type ConnectionProps,
  connectionPropsDiffer,
  observedDiffers,
  targetChanged,
  toLinkerInput,
} from "./ConnectionProperties.ts";

export interface LinkerProps extends ConnectionProps {
  /**
   * ARM ID of the source compute resource: an App Service site or slot, a
   * Container App, or a Spring Apps deployment. Changing it replaces the
   * linker.
   */
  source: string;
  /**
   * Linker name: letters, digits, `.` and `_`. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * linker.
   */
  name?: string;
}

export interface Linker extends Resource<
  "Azure.ServiceConnector.Linker",
  LinkerProps,
  {
    /** Name of the linker. */
    linkerName: string;
    /** ARM resource ID of the linker. */
    linkerId: string;
    /** ARM ID of the source compute resource. */
    source: string;
    /** Target service type. */
    targetType: string;
    /** ARM ID (or endpoint) of the target service. */
    target: string;
    /** Authentication type. */
    authType: string;
    /** Client library the configuration names target. */
    clientType: string;
    /** Provisioning state reported by Service Connector. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Connector linker — a managed connection from an App Service
 * site, Container App, or Spring Apps deployment to a target service.
 *
 * Service Connector writes the connection settings (endpoints, connection
 * strings, client IDs) into the source's app settings and, for identity
 * auth, enables the identity and grants RBAC roles on the target.
 *
 * Linkers cannot be tagged. The generated name encodes the app, stage,
 * logical ID, and instance ID, which is how Alchemy recognises its own
 * linkers; a linker with a custom name found without state is reported as
 * unowned.
 *
 * @see https://learn.microsoft.com/azure/service-connector/overview
 *
 * ### Connecting a Web App to Storage
 * **Example:** Connection string in app settings
 * ```typescript
 * yield* Azure.ServiceConnector.Linker("storage", {
 *   source: app.siteId,
 *   targetService: {
 *     type: "AzureResource",
 *     id: Output.interpolate`${account.storageAccountId}/blobServices/default`,
 *   },
 *   authInfo: { authType: "secret" },
 *   clientType: "nodejs",
 * });
 * ```
 *
 * **Example:** Managed identity with RBAC
 * ```typescript
 * yield* Azure.ServiceConnector.Linker("storage", {
 *   source: app.siteId,
 *   targetService: {
 *     type: "AzureResource",
 *     id: Output.interpolate`${account.storageAccountId}/blobServices/default`,
 *   },
 *   authInfo: { authType: "systemAssignedIdentity" },
 *   clientType: "nodejs",
 * });
 * ```
 *
 * ### Cleaning Up on Delete
 * **Example:** Remove generated settings with the linker
 * ```typescript
 * yield* Azure.ServiceConnector.Linker("storage", {
 *   source: app.siteId,
 *   targetService: { type: "AzureResource", id: blobServiceId },
 *   authInfo: { authType: "secret" },
 *   configurationInfo: { deleteOrUpdateBehavior: "ForcedCleanup" },
 * });
 * ```
 *
 * @resource
 */
export const Linker = Resource<Linker>("Azure.ServiceConnector.Linker");

/** Deterministic linker name (`^[A-Za-z0-9._]+$`). */
export const createLinkerName = (id: string, instanceId: string) =>
  createPhysicalName({ id, instanceId, maxLength: 60, delimiter: "_" }).pipe(
    Effect.map((name) => name.replaceAll("-", "_")),
  );

const getLinker = (resourceUri: string, linkerName: string) =>
  orUndefinedIfNotFound(servicelinker.GetLinker({ resourceUri, linkerName }));

const toAttrs = (
  source: string,
  name: string,
  linker: servicelinker.GetLinkerResponse,
): Linker["Attributes"] => ({
  linkerName: name,
  linkerId:
    linker.id ?? `${source}/providers/Microsoft.ServiceLinker/linkers/${name}`,
  source,
  targetType: linker.properties?.targetService?.type ?? "",
  target:
    linker.properties?.targetService?.id ??
    linker.properties?.targetService?.endpoint ??
    "",
  authType: linker.properties?.authInfo?.authType ?? "",
  clientType: linker.properties?.clientType ?? "none",
  provisioningState: linker.properties?.provisioningState,
});

const sameId = (a: string, b: string) =>
  a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

export const LinkerProvider = () =>
  Provider.succeed(Linker, {
    stables: ["linkerName", "linkerId", "source"],

    // Linkers are extension resources deleted with their source.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) {
        // An unresolved source means the source is being replaced.
        return "source" in news && isResolved(news.source)
          ? undefined
          : ({ action: "replace" } as const);
      }
      if (
        !sameId(news.source, output.source) ||
        (news.name !== undefined && news.name !== output.linkerName) ||
        news.targetService.type !== output.targetType ||
        !sameId(
          news.targetService.type === "AzureResource"
            ? news.targetService.id
            : news.targetService.endpoint,
          output.target,
        )
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const source = output?.source ?? olds?.source;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its source.
      if (source === undefined) return undefined;
      const generated = yield* createLinkerName(id, instanceId);
      const name = output?.linkerName ?? olds?.name ?? generated;
      const observed = yield* getLinker(source, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(source, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceLinker");
      const source = news.source;
      const name =
        news.name ??
        output?.linkerName ??
        (yield* createLinkerName(id, instanceId));
      const label = `service connector linker ${name}`;
      const get = getLinker(source, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is an upsert; GET does not echo secrets or
      // most options, so previous props are the baseline for those.
      if (
        observed === undefined ||
        observedDiffers(observed.properties, news) ||
        olds === undefined ||
        connectionPropsDiffer(olds, news)
      ) {
        yield* servicelinker.LinkerCreateOrUpdate({
          resourceUri: source,
          linkerName: name,
          properties: toLinkerInput(news),
        });
      }

      const fresh = yield* waitForProvisioned(
        label,
        get,
        (linker) => linker.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(source, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        servicelinker.DeleteLinker({
          resourceUri: output.source,
          linkerName: output.linkerName,
        }),
      );
      yield* waitUntilGone(
        `service connector linker ${output.linkerName}`,
        getLinker(output.source, output.linkerName),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Web.*",
        "Azure.ContainerApps.*",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
