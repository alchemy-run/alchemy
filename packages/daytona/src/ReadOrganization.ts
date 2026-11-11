import * as organizations from "@distilled.cloud/daytona/organizations";
import * as regions from "@distilled.cloud/daytona/regions";
import * as webhooks from "@distilled.cloud/daytona/webhooks";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccess } from "./DaytonaBindings.ts";
import { pick, scopeModule, type ScopedModule } from "./internal/Scoped.ts";

const ORGANIZATION_READS = [
  "getGpuCapacity",
  "listAvailableSandboxClasses",
  "getOrganizationUsageOverview",
] as const;

const WEBHOOK_READS = [
  "getWebhookControllerAppPortalAccess",
  "getWebhookControllerInitializationStatus",
] as const;

/** Read-only views of the organization: quotas, usage, GPU capacity, regions and the webhook portal. */
export interface ReadOrganizationClient
  extends
    ScopedModule<Pick<typeof organizations, (typeof ORGANIZATION_READS)[number]>>,
    ScopedModule<typeof regions>,
    ScopedModule<Pick<typeof webhooks, (typeof WEBHOOK_READS)[number]>> {}

/**
 * Read the organization's limits and usage at runtime: current usage
 * against quotas, which sandbox classes and GPUs are available, and the
 * shared regions. Use it to pick a region or refuse work before hitting a
 * quota.
 *
 * The host gets its own Daytona API key with `read:limits`.
 *
 * ### Checking Capacity
 * **Example:** Refuse a GPU job when no GPUs are free
 * ```typescript
 * const org = yield* Daytona.ReadOrganization();
 * const capacity = yield* org.getGpuCapacity();
 * ```
 *
 * @binding
 * @product Organization
 */
export interface ReadOrganization extends Binding.Service<
  ReadOrganization,
  "Daytona.ReadOrganization",
  () => Effect.Effect<ReadOrganizationClient>
> {}

export const ReadOrganization = Binding.Service<ReadOrganization>("Daytona.ReadOrganization");

/** {@link ReadOrganization} over Daytona's HTTP API; works on any host. */
export const ReadOrganizationHttp = Layer.effect(
  ReadOrganization,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* () {
      const { authorize, organizationId } = yield* access("Organization", ["read:limits"]);
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => authorize(effect);
      return lazyScoped(organizationId, (id) => ({
        ...scopeModule(pick(organizations, ORGANIZATION_READS), { organizationId: id }, run),
        ...scopeModule(regions, {}, run),
        ...scopeModule(pick(webhooks, WEBHOOK_READS), { organizationId: id }, run),
      }));
    });
  }),
);

/** Build a scoped client whose organization id resolves at runtime. */
export const lazyScoped = <C extends object>(
  organizationId: Effect.Effect<string, never, any>,
  make: (organizationId: string) => C,
): C =>
  new Proxy({} as C, {
    get:
      (_t, key: string) =>
      (...args: unknown[]) =>
        // `key` is a property of C (the Proxy only sees C's members), but a
        // Proxy trap types it as string, so the lookup is untyped here.
        Effect.flatMap(organizationId, (id) => (make(id) as any)[key](...args)),
  });
