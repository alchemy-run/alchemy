import * as identity from "@distilled.cloud/azure/confidentialledger-identity";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { collectAll } from "../Arm.ts";
import * as AzureBindings from "../AzureBindings.ts";
import { Application } from "../Entra/Application.ts";
import { ServicePrincipal } from "../Entra/ServicePrincipal.ts";
import { ledgerEndpointOf, overLedgerTls } from "./internal.ts";
import type { Ledger, LedgerRoleName } from "./Ledger.ts";
import { LedgerRoleAssignment } from "./LedgerRoleAssignment.ts";

/**
 * Shared scaffolding for the Confidential Ledger HTTP bindings. NOT exported
 * from `index.ts`: every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeLedgerHttpBinding({ … }))`.
 *
 * Ledger data-plane access is the ledger's own user list, not Azure RBAC,
 * so a binding cannot use `AzureBindings` role assignments. It gives the
 * host's principal a ledger role with a {@link LedgerRoleAssignment} (one
 * per host, ledger and role), and calls the ledger over TLS that trusts the
 * ledger's own certificate (see `internal.ts`).
 */

/**
 * The Entra principal a host's Azure calls run as: its managed identity
 * (`principalId`), or the service principal `AzureBindings.Bind` created for
 * a host without one.
 */
const HostPrincipal = Effect.gen(function* () {
  const EntraApplication = yield* Application;
  const EntraServicePrincipal = yield* ServicePrincipal;
  return Effect.fn(function* (host: ResourceLike) {
    if (AzureBindings.runsAsManagedIdentity(host)) {
      // Every managed-identity host has a `principalId` attribute;
      // `ResourceLike` does not carry attribute types.
      const { principalId } = host as unknown as {
        principalId: Output.Output<string | undefined>;
      };
      return principalId.pipe(Output.map((id) => id ?? ""));
    }
    // `AzureBindings.Bind` registered these under the same IDs and props;
    // declaring them again returns the registered resources.
    const id = `${host.LogicalId}AzureIdentity`;
    const app = yield* EntraApplication(id, {
      displayName: `Alchemy: Azure access for ${host.LogicalId}`.slice(0, 120),
      notes: `Created by Alchemy for ${host.Type} ${host.LogicalId} to call Azure.`,
    });
    const principal = yield* EntraServicePrincipal(`${id}Principal`, { appId: app.appId });
    return principal.objectId;
  });
});

type GrantOnLedger = (
  tag: string,
  ledger: Ledger,
  role: LedgerRoleName | undefined,
) => Effect.Effect<void>;

/**
 * Attach the binding to its host and give the host's principal `role` on
 * the ledger (none for anonymous operations).
 */
const GrantOnLedger: Effect.Effect<GrantOnLedger> = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // The role resources exist only at deploy; a host bundle drops them.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const principalOf = yield* HostPrincipal;
  const RoleAssignment = yield* LedgerRoleAssignment;
  return Effect.fn(function* (tag: string, ledger: Ledger, role: LedgerRoleName | undefined) {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    // On a host without a managed identity this also creates its service
    // principal and binds the client secret into its env.
    yield* bind`${tag}(${ledger})`({});
    if (role === undefined) return;
    const host = yield* Binding.Host;
    if (host === undefined) return;
    const principalId = yield* principalOf(host);
    yield* RoleAssignment(`${host.LogicalId}${ledger.LogicalId}Ledger${role}`, {
      ledger: ledger.ledgerName,
      principalId,
      role,
    });
  });
});

/**
 * Run ledger calls for one bound ledger: resolves its name at runtime and
 * its TLS certificate once per instance (a plain cached value).
 */
const LedgerCalls = Effect.gen(function* () {
  const getLedgerIdentity = yield* AzureBindings.withCredentials(identity.GetLedgerIdentity);
  return Effect.fn(function* (ledger: Ledger) {
    const ledgerName = yield* ledger.ledgerName;
    let certificate: { readonly ledger: string; readonly pem: string } | undefined;
    const tlsFor = Effect.fn(function* (name: string) {
      if (certificate?.ledger !== name) {
        const found = yield* getLedgerIdentity({ ledgerId: name });
        certificate = { ledger: name, pem: found.ledgerTlsCertificate };
      }
      return overLedgerTls(certificate.pem);
    });
    /** Call `f` with the ledger's endpoint, over the ledger's TLS. */
    return <A, E>(f: (ledgerEndpoint: string) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const name = yield* ledgerName;
        const tls = yield* tlsFor(name);
        return yield* tls(f(ledgerEndpointOf(name)));
      });
  });
});

/** A distilled ledger operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

/** A distilled paginated ledger operation, resolved with the host's credentials. */
type PagedOperation<I, Item, E> = Effect.Effect<
  { readonly items: (input: I) => Stream.Stream<Item, E> },
  never,
  any
>;

/**
 * Build the impl Effect for a ledger operation whose request carries
 * `ledgerEndpoint`: the runtime callable injects the bound {@link Ledger}'s
 * endpoint, and the deploy-time half gives the host `role` on the ledger.
 */
export const makeLedgerHttpBinding = <I extends { ledgerEndpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ConfidentialLedger.CreateLedgerEntry`. */
  tag: string;
  /** The distilled operation; the ledger endpoint is injected. */
  operation: Operation<I, A, E>;
  /** Ledger role the host gets. */
  role: LedgerRoleName;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnLedger;
    const callsOn = yield* LedgerCalls;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (ledger: Ledger) {
      yield* grant(options.tag, ledger, options.role);
      const call = yield* callsOn(ledger);
      return Effect.fn(`${options.tag}(${ledger.LogicalId})`)(function* (
        request?: Omit<I, "ledgerEndpoint">,
      ) {
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* call((ledgerEndpoint) => op({ ...request, ledgerEndpoint } as I));
      });
    });
  });

/**
 * Build the impl Effect for a paginated ledger list operation: the runtime
 * callable injects the ledger endpoint and returns every item across pages.
 */
export const makeLedgerListHttpBinding = <I extends { ledgerEndpoint: string }, Item, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ConfidentialLedger.ListCollections`. */
  tag: string;
  /** The distilled paginated operation. */
  operation: PagedOperation<I, Item, E>;
  /** Ledger role the host gets. */
  role: LedgerRoleName;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnLedger;
    const callsOn = yield* LedgerCalls;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (ledger: Ledger) {
      yield* grant(options.tag, ledger, options.role);
      const call = yield* callsOn(ledger);
      return Effect.fn(`${options.tag}(${ledger.LogicalId})`)(function* (
        request?: Omit<I, "ledgerEndpoint" | "nextLink">,
      ) {
        const all = yield* call((ledgerEndpoint) =>
          collectAll(op, { ...request, ledgerEndpoint } as I),
        );
        return all.value;
      });
    });
  });

/** The per-operation callables a ledger access-level client is built from. */
export interface LedgerCallables {
  /** Wrap a distilled operation: the ledger endpoint is injected. */
  readonly one: <I extends { ledgerEndpoint: string }, A, E>(
    op: (input: I) => Effect.Effect<A, E>,
  ) => (
    request?: Omit<I, "ledgerEndpoint">,
  ) => Effect.Effect<A, E | identity.GetLedgerIdentityError>;
  /** Wrap a paginated distilled operation: every item across pages. */
  readonly all: <I extends { ledgerEndpoint: string }, Item, E>(op: {
    readonly items: (input: I) => Stream.Stream<Item, E>;
  }) => (
    request?: Omit<I, "ledgerEndpoint" | "nextLink">,
  ) => Effect.Effect<Item[], E | identity.GetLedgerIdentityError>;
}

/**
 * Build the impl Effect for an access-level binding (`LedgerRead`,
 * `LedgerWrite`, `LedgerReadWrite`): one ledger role for the whole client,
 * whose methods `build` assembles from operations resolved with the host's
 * credentials (resolve them in `resolve`, one at a time).
 */
export const makeLedgerAccessHttpBinding = <Ops, Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ConfidentialLedger.LedgerRead`. */
  tag: string;
  /** Ledger role the host gets. */
  role: LedgerRoleName;
  /** Resolve the distilled operations the client needs. */
  resolve: Effect.Effect<Ops>;
  /** Assemble the client from the resolved operations. */
  build: (ops: Ops, callables: LedgerCallables) => Client;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnLedger;
    const callsOn = yield* LedgerCalls;
    const ops = yield* options.resolve;
    return Effect.fn(function* (ledger: Ledger) {
      yield* grant(options.tag, ledger, options.role);
      const call = yield* callsOn(ledger);
      const callables: LedgerCallables = {
        one: (op) => (request) =>
          call((ledgerEndpoint) =>
            // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
            op({ ...request, ledgerEndpoint } as Parameters<typeof op>[0]),
          ),
        all: (op) => (request) =>
          call((ledgerEndpoint) =>
            collectAll(op, { ...request, ledgerEndpoint } as Parameters<typeof op.items>[0]),
          ).pipe(Effect.map((page) => page.value)),
      };
      return options.build(ops, callables);
    });
  });

/**
 * Build the impl Effect for the anonymous `GetLedgerIdentity`: no role, the
 * bound ledger's name is the `ledgerId`.
 */
export const makeLedgerIdentityHttpBinding = (tag: string) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnLedger;
    const op = yield* AzureBindings.withCredentials(identity.GetLedgerIdentity);
    return Effect.fn(function* (ledger: Ledger) {
      yield* grant(tag, ledger, undefined);
      const ledgerName = yield* ledger.ledgerName;
      return Effect.fn(`${tag}(${ledger.LogicalId})`)(function* () {
        const ledgerId = yield* ledgerName;
        return yield* op({ ledgerId });
      });
    });
  });
