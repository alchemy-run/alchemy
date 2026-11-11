import * as usage from "@distilled.cloud/daytona/usage";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccess } from "./DaytonaBindings.ts";
import { scopeModule, type OrganizationFixed, type ScopedModule } from "./internal/Scoped.ts";
import { lazyScoped } from "./ReadOrganization.ts";

/** Usage from Daytona's analytics API: totals, charts and per-sandbox usage. */
export interface ReadUsageClient extends ScopedModule<typeof usage, OrganizationFixed> {}

/**
 * Read the organization's compute usage at runtime: aggregated totals, a
 * chart over time, and usage per sandbox. Use it to bill your own users
 * for the sandboxes you run for them.
 *
 * The host gets its own Daytona API key with `read:billing`.
 *
 * ### Usage per Sandbox
 * **Example:** Usage over the last day
 * ```typescript
 * const usage = yield* Daytona.ReadUsage();
 * const rows = yield* usage.listOrganizationUsageSandbox({ from, to });
 * ```
 *
 * @binding
 * @product Organization
 */
export interface ReadUsage extends Binding.Service<
  ReadUsage,
  "Daytona.ReadUsage",
  () => Effect.Effect<ReadUsageClient>
> {}

export const ReadUsage = Binding.Service<ReadUsage>("Daytona.ReadUsage");

/** {@link ReadUsage} over Daytona's analytics API; works on any host. */
export const ReadUsageHttp = Layer.effect(
  ReadUsage,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* () {
      const { authorize, organizationId } = yield* access("Usage", ["read:billing"]);
      return lazyScoped(organizationId, (id) =>
        scopeModule<typeof usage, OrganizationFixed>(usage, { organizationId: id }, (effect) =>
          authorize(effect),
        ),
      );
    });
  }),
);
