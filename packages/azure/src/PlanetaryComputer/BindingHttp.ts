import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * Shared scaffolding for the Planetary Computer Pro GeoCatalog data-plane
 * bindings: resolves the distilled `orbital-planetary-computer` operation
 * once when the layer is built, injects the bound catalog's `catalogUri`,
 * and assigns the binding's role on that catalog at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * The built-in role a GeoCatalog binding assigns on the bound catalog.
 * `Microsoft.Orbital` has no data actions: the GeoCatalog data plane checks
 * the control-plane actions of these two roles, so no narrower custom role
 * exists.
 */
export type GeoCatalogGrant = { readonly builtIn: string };

/** The roles the GeoCatalog bindings assign. */
export const GeoCatalogRole = {
  /** Built-in **GeoCatalog Reader**: reads the catalog's data (`geoCatalogs/read`). */
  Reader: { builtIn: "b7b8f583-43d0-40ae-b147-6b46f53661c1" },
  /** Built-in **GeoCatalog Administrator**: reads, writes and deletes the catalog's data. */
  Administrator: { builtIn: "c9c97b9c-105d-4bb5-a2a7-7d15666c2484" },
} as const satisfies Record<string, GeoCatalogGrant>;

/** Assign `grant` on the catalog to the host. */
const GrantGeoCatalogRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  return Effect.fn(function* (tag: string, catalog: GeoCatalog, grant: GeoCatalogGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: grant.builtIn, scope: catalog.catalogId },
      ];
      yield* bind`${tag}(${catalog})`({ roleAssignments });
    }
  });
});

/**
 * Build the impl Effect for a GeoCatalog data-plane operation: the runtime
 * callable injects the bound {@link GeoCatalog}'s `catalogUri` as
 * `endpoint`, and the deploy-time half assigns `grant` on the catalog.
 */
export const makeGeoCatalogHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.PlanetaryComputer.GetStacItem`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Role assigned on the catalog. */
  grant: GeoCatalogGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantGeoCatalogRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (catalog: GeoCatalog) {
      yield* grant(options.tag, catalog, options.grant);
      const catalogUri = yield* catalog.catalogUri;
      return Effect.fn(`${options.tag}(${catalog.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const endpoint = yield* catalogUri;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: endpoint ?? "" } as I);
      });
    });
  });
