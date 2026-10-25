import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Provider } from "./Provider.ts";

/**
 * Shared scaffolding for the Azure Attestation HTTP bindings. NOT exported
 * from `index.ts`: every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeAttestationHttpBinding({ … }))`.
 *
 * Attestation policy access is Azure RBAC on the provider, with control-plane
 * `actions` (the service defines no data actions). The built-in
 * **Attestation Reader** also reads the provider resource and **Attestation
 * Contributor** also deletes, so each binding kind gets a custom role with
 * exactly its action, assigned on the provider only.
 */

/** Attestation policy actions (Azure RBAC). */
export const AttestationAction = {
  read: "Microsoft.Attestation/attestationProviders/attestation/read",
  write: "Microsoft.Attestation/attestationProviders/attestation/write",
} as const;

/**
 * A custom role a binding assigns on the provider (one per stack, logical
 * ID `AzureAttestation<role>Role`), or `undefined` for the anonymous
 * endpoints (attest, signing certificates, OpenID metadata).
 */
export type AttestationGrant = { readonly role: string; readonly actions: readonly string[] };

export const AttestationRole = {
  PolicyRead: { role: "PolicyRead", actions: [AttestationAction.read] },
  PolicyWrite: { role: "PolicyWrite", actions: [AttestationAction.write] },
} as const satisfies Record<string, AttestationGrant>;

/** Attach the binding to its host and assign `grant` on the provider. */
const GrantOnProvider = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    provider: Provider,
    grant: AttestationGrant | undefined,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      if (grant !== undefined) {
        const role = yield* AzureRoleDefinition(`AzureAttestation${grant.role}Role`, {
          description: `Alchemy Attestation binding: ${grant.actions.join(", ")}`,
          permissions: [{ actions: [...grant.actions] }],
        });
        roleAssignments.push({
          roleDefinitionId: role.roleDefinitionId,
          scope: provider.providerId,
        });
      }
      yield* bind`${tag}(${provider})`({ roleAssignments });
    }
  });
});

/** A distilled attestation operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

/**
 * Build the impl Effect for an attestation operation whose request carries
 * `endpoint`: the runtime callable injects the bound {@link Provider}'s
 * attest URI, and the deploy-time half assigns `grant` on the provider.
 */
export const makeAttestationHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Attestation.GetPolicy`. */
  tag: string;
  /** The distilled operation; the attest URI is injected as `endpoint`. */
  operation: Operation<I, A, E>;
  /** Role assigned on the provider; `undefined` for anonymous endpoints. */
  grant: AttestationGrant | undefined;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnProvider;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (provider: Provider) {
      yield* grant(options.tag, provider, options.grant);
      const attestUri = yield* provider.attestUri;
      return Effect.fn(`${options.tag}(${provider.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const endpoint = yield* attestUri;
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint } as I);
      });
    });
  });
