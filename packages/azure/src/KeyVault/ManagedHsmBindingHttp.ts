import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { collectAll } from "../Arm.ts";
import * as AzureBindings from "../AzureBindings.ts";
import { Application } from "../Entra/Application.ts";
import { ServicePrincipal } from "../Entra/ServicePrincipal.ts";
import type { ManagedHsm } from "./ManagedHsm.ts";
import { ManagedHsmRoleAssignment } from "./ManagedHsmRoleAssignment.ts";
import {
  type ManagedHsmDataAction,
  ManagedHsmRoleDefinition,
  managedHsmUri,
} from "./ManagedHsmRoleDefinition.ts";

/**
 * Shared scaffolding for the Managed HSM administration and security-domain
 * HTTP bindings. NOT exported from `index.ts`: every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeManagedHsmHttpBinding({ … }))`.
 *
 * Managed HSM data-plane access is the HSM's own local RBAC, not Azure
 * RBAC, so a binding cannot use `AzureBindings` role assignments. It
 * grants the host's principal a local role instead:
 *
 * - a custom {@link ManagedHsmRoleDefinition} with exactly the operation's
 *   data actions (one per HSM and binding kind, shared by every host), or
 *   a built-in role where the operation has no documented data action;
 * - one {@link ManagedHsmRoleAssignment} per host and binding kind, at the
 *   HSM scope `/`.
 */

/** The local RBAC role a binding needs on the HSM. */
export type ManagedHsmGrant =
  /** A custom role with exactly these data actions. */
  | { readonly kind: string; readonly dataActions: readonly ManagedHsmDataAction[] }
  /** A built-in role GUID (`ManagedHsmBuiltInRole.*`). */
  | { readonly kind: string; readonly builtInRole: string };

/** A Managed HSM binding was bound to a host whose principal Alchemy cannot name. */
export class ManagedHsmBindingUnsupportedHost extends Data.TaggedError(
  "Azure.KeyVault.ManagedHsmBindingUnsupportedHost",
)<{ readonly host: string; readonly message: string }> {}

const GrantOnManagedHsm = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Bindings only grant at deploy, so a host bundle captures nothing here.
  if (globalThis.__ALCHEMY_RUNTIME__) {
    return (_tag: string, _hsm: ManagedHsm, _grant: ManagedHsmGrant) => Effect.void;
  }
  const RoleDefinition = yield* ManagedHsmRoleDefinition;
  const RoleAssignment = yield* ManagedHsmRoleAssignment;
  const application = yield* Application;
  const servicePrincipal = yield* ServicePrincipal;

  /** The host's principal object ID, as an Output. */
  const hostPrincipalId = Effect.fn(function* (host: ResourceLike) {
    if (host.Type.startsWith("Kubernetes.")) {
      return yield* Effect.die(
        new ManagedHsmBindingUnsupportedHost({
          host: host.LogicalId,
          message: `${host.Type} ${host.LogicalId}: Managed HSM bindings need the host's principal ID; grant the workload identity a ManagedHsmRoleAssignment instead.`,
        }),
      );
    }
    if (AzureBindings.runsAsManagedIdentity(host)) {
      // Every non-Kubernetes managed-identity host exposes its
      // system-assigned identity as `principalId`; `ResourceLike` does not
      // type its attributes.
      const principal = (
        Output.of(host) as unknown as { principalId: Output.Output<string | undefined> }
      ).principalId;
      return Output.map(principal, (id) => id ?? "");
    }
    // `AzureBindings.Bind` registered the host's Entra application and
    // service principal under these logical IDs (with these props); yielding
    // an ID again returns the registered resource.
    const id = `${host.LogicalId}AzureIdentity`;
    const app = yield* application(id, {
      displayName: `Alchemy: Azure access for ${host.LogicalId}`.slice(0, 120),
      notes: `Created by Alchemy for ${host.Type} ${host.LogicalId} to call Azure.`,
    });
    const principal = yield* servicePrincipal(`${id}Principal`, { appId: app.appId });
    return principal.objectId;
  });

  return Effect.fn(function* (tag: string, hsm: ManagedHsm, grant: ManagedHsmGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (host === undefined) return;
      // A host without a managed identity gets its Entra identity and the
      // credential env vars here; the role itself is local to the HSM.
      yield* bind`${tag}(${hsm})`({});
      const principalId = yield* hostPrincipalId(host);
      const roleDefinitionId =
        "builtInRole" in grant
          ? grant.builtInRole
          : (yield* RoleDefinition(`${hsm.LogicalId}${grant.kind}Role`, {
              managedHsm: hsm.managedHsmName,
              description: `Alchemy binding ${tag}`,
              dataActions: [...grant.dataActions],
            })).roleDefinitionId;
      yield* RoleAssignment(`${host.LogicalId}${hsm.LogicalId}${grant.kind}`, {
        managedHsm: hsm.managedHsmName,
        scope: "/",
        roleDefinitionId,
        principalId,
      });
    }
  });
});

/**
 * Build the impl Effect for a Managed HSM operation whose request carries
 * the HSM as `vaultBaseUrl`: the runtime callable injects the bound
 * {@link ManagedHsm}'s endpoint and the deploy-time half grants `grant` to
 * the host on the HSM.
 */
export const makeManagedHsmHttpBinding = <I extends { vaultBaseUrl: string }, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.StartFullBackup`. */
  tag: string;
  /** The distilled operation; the HSM endpoint is injected as `vaultBaseUrl`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** The local RBAC role granted to the host on the HSM. */
  grant: ManagedHsmGrant;
}) =>
  Effect.gen(function* () {
    const grantOnManagedHsm = yield* GrantOnManagedHsm;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (hsm: ManagedHsm) {
      yield* grantOnManagedHsm(options.tag, hsm, options.grant);
      const hsmName = yield* hsm.managedHsmName;
      return Effect.fn(`${options.tag}(${hsm.LogicalId})`)(function* (
        request?: Omit<I, "vaultBaseUrl">,
      ) {
        const name = yield* hsmName;
        return yield* op({ ...request, vaultBaseUrl: managedHsmUri(name) } as I);
      });
    });
  });

/**
 * Build the impl Effect for a paginated Managed HSM list operation: the
 * runtime callable injects the HSM endpoint and returns every item across
 * pages.
 */
export const makeManagedHsmListHttpBinding = <
  I extends { vaultBaseUrl: string },
  Item,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.ListHsmRoleAssignments`. */
  tag: string;
  /** The distilled paginated operation. */
  operation: Effect.Effect<{ readonly items: (input: I) => Stream.Stream<Item, E> }, never, R>;
  /** The local RBAC role granted to the host on the HSM. */
  grant: ManagedHsmGrant;
}) =>
  Effect.gen(function* () {
    const grantOnManagedHsm = yield* GrantOnManagedHsm;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (hsm: ManagedHsm) {
      yield* grantOnManagedHsm(options.tag, hsm, options.grant);
      const hsmName = yield* hsm.managedHsmName;
      return Effect.fn(`${options.tag}(${hsm.LogicalId})`)(function* (
        request: Omit<I, "vaultBaseUrl" | "nextLink">,
      ) {
        const name = yield* hsmName;
        const all = yield* collectAll(op, { ...request, vaultBaseUrl: managedHsmUri(name) } as I);
        return all.value;
      });
    });
  });
