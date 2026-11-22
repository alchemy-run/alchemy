import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Client from "./internal/Client.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import {
  findServiceByLookup,
  listServicesByType,
  mapBaseServiceAttrs,
  observeServiceForProvider,
  precreateLongRunningService,
  readServiceForProvider,
  reconcileLongRunningService,
  type HydratedServiceData,
  type LongRunningServiceProps,
  type ServiceAttributes,
} from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { RenderServiceBinding } from "./RenderBindings.ts";
import type { OpenPortInfo, PaidPlan } from "./Types.ts";

export interface PrivateServiceProps extends LongRunningServiceProps {
  /** Paid instance plan (`"starter"`, `"standard"`, `"pro"`, `"pro_plus"`, `"pro_max"`, `"pro_ultra"`, etc.). */
  plan?: PaidPlan;
}

export interface PrivateServiceAttributes extends ServiceAttributes {
  /** Private network URL reachable within the Render workspace/region. */
  url?: string;
  /** Open internal ports exposed on the private service. */
  openPorts: OpenPortInfo[];
}

export interface PrivateServiceLookup {
  /** Look up an existing private service by Render service ID (`srv-...`). */
  id?: string;
  /** Look up an existing private service by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render Private Service listens on internal private network ports reachable
 * only from other services inside your Render workspace.
 *
 * **Example:** Internal gRPC/HTTP private service
 * ```typescript
 * const internal = yield* Render.PrivateService("InternalApi", {
 *   name: "internal-api",
 *   plan: "starter",
 *   region: "oregon",
 *   runtimeSource: {
 *     image: { imagePath: "ghcr.io/org/internal-api", tag: "latest" },
 *   },
 * });
 * ```
 *
 * @resource
 * @product Compute
 * @category Compute
 */
export interface PrivateService extends Resource<
  "Render.PrivateService",
  PrivateServiceProps,
  PrivateServiceAttributes,
  RenderServiceBinding,
  Providers,
  PrivateServiceLookup
> {}

export const PrivateService = Resource<PrivateService>("Render.PrivateService");

const mapPrivateService = (data: HydratedServiceData): PrivateServiceAttributes => ({
  ...mapBaseServiceAttrs(data),
  url: data.service.serviceDetails.url,
  openPorts: data.service.serviceDetails.openPorts ?? [],
});

export const PrivateServiceProvider = () =>
  Provider.effect(
    PrivateService,
    Effect.succeed({
      stables: ["id", "slug"],
      nuke: {
        dependsOn: [
          "Render.Environment",
          "Render.Project",
          "Render.RegistryCredential",
          "Render.EnvGroup",
        ],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (news.region !== undefined && olds.region !== undefined && news.region !== olds.region) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        return yield* readServiceForProvider({
          serviceType: "private_service",
          id,
          olds,
          output,
          previous,
          toAttributes: mapPrivateService,
        });
      }),
      observe: Effect.fn(function* ({ id, news, previous }) {
        return yield* observeServiceForProvider({
          serviceType: "private_service",
          id,
          news,
          previous,
        });
      }),
      precreate: Effect.fn(function* ({ id, news }) {
        return yield* precreateLongRunningService<PrivateServiceProps, PrivateServiceAttributes>({
          resourceType: "Render.PrivateService",
          serviceType: "private_service",
          id,
          news,
          defaultPlan: "starter",
          toAttributes: mapPrivateService,
        });
      }),
      logs: Effect.fn(function* ({ output, options }) {
        return yield* renderResourceLogs({
          ownerId: output.ownerId,
          resourceId: output.id,
          options,
        });
      }),
      tail: ({ output }) =>
        renderResourceTail({
          ownerId: output.ownerId,
          resourceId: output.id,
        }),
      lookup: Effect.fn(function* (props) {
        const hydrated = yield* findServiceByLookup("private_service", props);
        return hydrated ? mapPrivateService(hydrated) : undefined;
      }),
      list: Effect.fn(function* () {
        const all = yield* listServicesByType("private_service");
        return all.map(mapPrivateService);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        return yield* reconcileLongRunningService<PrivateServiceProps, PrivateServiceAttributes>({
          resourceType: "Render.PrivateService",
          serviceType: "private_service",
          id,
          news,
          olds,
          output,
          desiredName,
          bindings: bindings.map((b) => b.data),
          defaultPlan: "starter",
          extraCreateDetails: () => ({}),
          extraUpdateDetails: () => ({}),
          toAttributes: mapPrivateService,
        });
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteService(output.id);
      }),
    }),
  );
