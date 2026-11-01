import {
  Credentials,
  fromServiceAccountKey,
  parseServiceAccountKey,
} from "@distilled.cloud/stackit/Credentials";
import type { StackitOpContext } from "@distilled.cloud/stackit/Protocol";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import { StackitEnvironment } from "./Environment.ts";
import { CustomRole } from "./IAM/CustomRole.ts";
import { type AuthorizationResourceType, Membership } from "./IAM/Membership.ts";
import { ServiceAccount } from "./IAM/ServiceAccount.ts";
import { ServiceAccountKey } from "./IAM/ServiceAccountKey.ts";

/**
 * How a STACKIT binding reaches STACKIT from its host:
 *
 * - the host runs as a STACKIT service account: grants go on that identity,
 *   and calls use its credentials. No host does yet (see
 *   {@link runsAsServiceAccount});
 * - any other host (a Cloudflare Worker, a Lambda, a Cloud Run service):
 *   Alchemy creates a `Stackit.IAM.ServiceAccount` and `ServiceAccountKey`,
 *   gives the account one `Stackit.IAM.Membership` per grant, and binds the
 *   key file into the host's env as a `Redacted` value;
 * - no host (a script or deploy-time Action): nothing is bound and calls use
 *   the deployer's credentials.
 *
 * Import it as a namespace. A service's `BindingHttp.ts` builds on
 * {@link makeHttpBinding}, and each `<Op>Http.ts` is one `Layer.effect` over
 * it (see `ResourceManager/BindingHttp.ts` and `GetProjectHttp.ts`). A binding
 * that doesn't fit uses {@link Bind} and {@link withCredentials} directly:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const getZone = yield* StackitBindings.withCredentials(dns.getZone);
 *   const bind = yield* StackitBindings.Bind;
 *   return Effect.fn(function* (zone: Zone) {
 *     const projectId = yield* zone.projectId;
 *     const zoneId = yield* zone.zoneId;
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`Stackit.DNS.GetZone(${zone})`({
 *         grants: [StackitBindings.grantOn(zone, { role: "dns.reader" })],
 *       });
 *     }
 *     return () =>
 *       Effect.gen(function* () {
 *         return yield* getZone({ projectId: yield* projectId, zoneId: yield* zoneId });
 *       });
 *   });
 * })
 * ```
 *
 * ### Least privilege
 *
 * STACKIT binds roles on Resource Manager entities only: an organization, a
 * folder or a project. Binding on a single bucket or VM isn't supported, and a
 * role bound on a parent is inherited by its children. So **every grant is
 * broader than the bound resource**: it reaches all resources of that kind in
 * the project. That is the platform's limit, and {@link grantOn} is where it is
 * decided, so a binding's JSDoc only says what its role covers.
 *
 * Choose the scope and the access this way:
 *
 * 1. Scope: {@link grantOn}, the project holding the bound resource. Use
 *    {@link grantOnScope} only when the bound resource is itself a project,
 *    folder or organization, or lives outside a project.
 * 2. Access: the smallest predefined product role (`<product>.reader`,
 *    `<product>.admin`, as in `postgres-flex.reader`) that covers the
 *    operation, when that role does little more than the operation.
 * 3. Access, when the role is much broader: `permissions`, listing exactly
 *    what the operation needs. Alchemy defines one `Stackit.IAM.CustomRole`
 *    per permission set and scope, shared by every host in the stack. Use it
 *    when the only covering role is a general one (`reader`, `editor`,
 *    `owner`), or a product's `admin` role for a narrow operation.
 *
 * Never grant `owner` or `editor` from a binding. Take role and permission
 * names from STACKIT's docs or the spec's operation text, because a wrong name
 * fails the deploy. A custom role needs the deployer to hold `iam.role.add`,
 * and every grant needs `iam.member.add`, which STACKIT flags as high-privilege.
 *
 * @see https://docs.stackit.cloud/platform/access-and-identity/roles-permissions/roles-permissions/
 * @see https://docs.stackit.cloud/platform/access-and-identity/roles-permissions/custom-roles
 */

/** Where a role is bound: the only kinds of resource STACKIT binds roles on. */
export interface GrantScope {
  /** Kind of resource the role is bound on. */
  readonly resourceType: AuthorizationResourceType;
  /**
   * Id of the project, folder or organization. Omit it for the profile's
   * project or organization; a folder always needs it.
   */
  readonly resourceId?: Input<string>;
}

/**
 * What a grant allows: a predefined role, or the exact permissions of a
 * custom role. See "Least privilege" above for which one to use.
 */
export type Access =
  | {
      /** Predefined role, e.g. `dns.reader`. */
      readonly role: string;
    }
  | {
      /** Permissions of a custom role, e.g. `resource-manager.project.get`. */
      readonly permissions: readonly string[];
    };

/** One role binding a binding needs. Build it with {@link grantOn}. */
export type Grant = GrantScope & Access;

/** What a STACKIT binding attaches to its host. */
export interface HostBinding {
  /** The role bindings the binding needs. */
  readonly grants?: readonly Grant[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
}

/**
 * Grant `access` on the project holding `resource`, the narrowest scope STACKIT
 * allows, for any resource with a `projectId` prop. It reads the prop rather
 * than the attribute so two resources in one project share one role binding,
 * which matters because a membership has no identity beyond subject, role and
 * scope. Deploy-time only: call it behind the `__ALCHEMY_RUNTIME__` guard.
 */
export const grantOn = (resource: ResourceLike, access: Access): Grant => ({
  resourceType: "project",
  resourceId: resource.Props?.projectId as Input<string> | undefined,
  ...access,
});

/**
 * Grant `access` on an explicit scope: a bound project, folder or organization,
 * or a resource that lives outside a project. Use {@link grantOn} for anything
 * inside a project.
 */
export const grantOnScope = (scope: GrantScope, access: Access): Grant => ({
  ...scope,
  ...access,
});

/**
 * Build options for a bundle that runs on a host running as a STACKIT service
 * account: defines `__ALCHEMY_HOST_IDENTITY__` as `"Stackit.IAM.ServiceAccount"`
 * so the bundler drops the created-key credentials path.
 */
export const serviceAccountHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_HOST_IDENTITY__": JSON.stringify("Stackit.IAM.ServiceAccount"),
    },
  },
});

/**
 * Env vars holding the key Alchemy creates for a host that doesn't run as a
 * service account. Only {@link Bind} sets them, and only on that path, so at
 * runtime their presence is the whole decision.
 */
const KEY_ENV = {
  keyJson: "ALCHEMY_STACKIT_SERVICE_ACCOUNT_KEY",
  region: "ALCHEMY_STACKIT_REGION",
} as const;

/**
 * Host types that run as a STACKIT service account and accept
 * {@link HostBinding}. Empty until the first native runtime ships; that runtime
 * adds its type here and applies {@link serviceAccountHostBundle}.
 */
const SERVICE_ACCOUNT_HOSTS: ReadonlySet<string> = /*@__PURE__*/ new Set<string>();

/**
 * Whether a host runs its code as a STACKIT service account. Deploy-time only.
 */
export const runsAsServiceAccount = (host: ResourceLike): boolean =>
  SERVICE_ACCOUNT_HOSTS.has(host.Type);

/** Label a grant `Allow(<host>, <label>)`, as `host.bind` records it. */
const allow = (label: TemplateStringsArray): TemplateStringsArray => {
  const strings = ["Allow(", `, ${label[0]}`, ...label.slice(1)];
  strings[strings.length - 1] += ")";
  // A built array has no `TemplateStringsArray` brand the compiler accepts.
  return Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
};

/** `ResourceLike` doesn't declare a resource's `bind`; native hosts have one. */
type BindTarget = {
  bind: (...args: unknown[]) => (data: unknown) => Effect.Effect<void>;
};

const toOutput = (value: unknown) => (Output.isOutput(value) ? value : Output.literal(value));

/** FNV-1a: keeps logical ids short and stable. Not used for anything secret. */
const shortHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** `dns.reader` -> `DnsReader`, for readable logical ids. */
const pascalCase = (text: string): string =>
  text
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");

/** The profile's project, when the stack has a resolvable STACKIT environment. */
const profileProjectId: Effect.Effect<string | undefined> = Effect.serviceOption(
  StackitEnvironment,
).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed<string | undefined>(undefined),
      // A missing profile fails the Membership itself, with the same error.
      onSome: (current) =>
        current.pipe(
          Effect.map((env): string | undefined => env.projectId),
          Effect.orElseSucceed(() => undefined),
        ),
    }),
  ),
);

/**
 * Stable text for a grant's scope, the part of a membership's identity that
 * logical ids are built from. An Output's `toString` is its expression
 * (`MyProject.projectId`), so two grants on one Output share an id, and an
 * omitted project matches an explicit id equal to the profile's project.
 */
const scopeKey = (scope: GrantScope, defaultProjectId: string | undefined): string => {
  const id =
    scope.resourceId ?? (scope.resourceType === "project" ? defaultProjectId : undefined) ?? "";
  return `${scope.resourceType}:${typeof id === "string" ? id : id.toString()}`;
};

/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data: HostBinding) => Effect.Effect<void>;

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function, behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it.
 *
 * - a host that runs as a service account takes the binding through its
 *   {@link HostBinding} contract, labelled `Allow(<host>, <label>)`;
 * - any other host gets a service account and key. The account takes one
 *   membership per grant and the key is bound into the host's env.
 *
 * Grants are deduplicated by host, role and scope, so bindings sharing a role
 * share a membership and removing one of them can't revoke the other's access.
 * Custom roles are deduplicated by scope and permissions across the stack.
 *
 * ```ts
 * Effect.gen(function* () {
 *   const bind = yield* StackitBindings.Bind;
 *   return Effect.fn(function* (zone: Zone) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`Stackit.DNS.GetZone(${zone})`({
 *         grants: [StackitBindings.grantOn(zone, { role: "dns.reader" })],
 *       });
 *     }
 *   });
 * })
 * ```
 */
export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  // Bindings only bind at deploy, so a host bundle captures nothing here
  // and drops the identity resources.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const StackitServiceAccount = yield* ServiceAccount;
  const StackitServiceAccountKey = yield* ServiceAccountKey;
  const StackitMembership = yield* Membership;
  const StackitCustomRole = yield* CustomRole;

  return (label: TemplateStringsArray, ...args: unknown[]) =>
    Effect.fn(function* (data: HostBinding) {
      const host = yield* Binding.Host;
      if (host === undefined) return;

      if (runsAsServiceAccount(host)) {
        return yield* (host as unknown as BindTarget).bind(allow(label), host, ...args)(data);
      }

      const account = yield* StackitServiceAccount(`${host.LogicalId}ServiceAccount`, {});
      const defaultProjectId = yield* profileProjectId;

      for (const grant of data.grants ?? []) {
        const scope = scopeKey(grant, defaultProjectId);
        if ("role" in grant) {
          yield* StackitMembership(
            `${host.LogicalId}Grant${pascalCase(grant.role)}${shortHash(scope)}`,
            {
              subject: account.email,
              role: grant.role,
              resourceType: grant.resourceType,
              resourceId: grant.resourceId,
            },
          );
          continue;
        }
        const permissions = [...new Set(grant.permissions)].sort();
        const hash = shortHash(`${scope}|${permissions.join(",")}`);
        const role = yield* StackitCustomRole(`StackitBindingRole${hash}`, {
          description: `Alchemy binding role: ${permissions.join(", ")}`.slice(0, 255),
          permissions,
          resourceType: grant.resourceType,
          resourceId: grant.resourceId,
        });
        yield* StackitMembership(`${host.LogicalId}GrantCustom${hash}`, {
          subject: account.email,
          role: role.name,
          resourceType: grant.resourceType,
          resourceId: grant.resourceId,
        });
      }

      const key = yield* StackitServiceAccountKey(`${host.LogicalId}ServiceAccountKey`, {
        serviceAccountEmail: account.email,
        projectId: account.projectId,
      });
      const runtime = (yield* CurrentRuntimeContext)!;
      yield* runtime.set(KEY_ENV.keyJson, key.keyJson);
      yield* runtime.set(
        KEY_ENV.region,
        Output.fromEffect(
          StackitEnvironment.current.pipe(
            Effect.map((env) => env.region),
            Effect.orDie,
          ),
        ) as Output.Output<string>,
      );
      for (const [name, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(name, toOutput(value));
      }
    });
});

/**
 * The `Credentials` service for a bound key file. Its token cache lives in the
 * returned value. A malformed key fails each operation with `ConfigError`, the
 * same way a failed token exchange does, rather than killing the host at init.
 */
const credentialsFromKey = (keyJson: string, region: string | undefined) =>
  parseServiceAccountKey(keyJson).pipe(
    Effect.flatMap((key) =>
      Layer.build(
        fromServiceAccountKey({ key, region }).pipe(Layer.provide(FetchHttpClient.layer)),
      ).pipe(Effect.scoped),
    ),
    Effect.map((context) => Context.get(context, Credentials)),
    Effect.catchTag("ConfigError", (error) => Effect.succeed(Effect.fail(error))),
  );

/**
 * Resolve a distilled operation with the host's STACKIT credentials, once when
 * the binding's layer is built: with the key {@link Bind} created for this host
 * if there is one, as-is otherwise (the host's own service account, or the
 * deployer).
 *
 * Calls go to the region the stack deployed from, which decides the host of
 * region-hosted APIs (`functions`, `secrets_manager`, ...). APIs with a
 * `region` path parameter take it from the request.
 */
export const withCredentials: <Op>(operation: Effect.Effect<Op, never, any>) => Effect.Effect<Op> =
  Effect.fn(function* <Op>(operation: Effect.Effect<Op, never, any>) {
    // A host running as a service account signs with its own credentials.
    if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "Stackit.IAM.ServiceAccount")
      return yield* operation as Effect.Effect<Op>;
    const runtime = yield* CurrentRuntimeContext;
    const keyJson =
      globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined
        ? yield* runtime.get<string | Redacted.Redacted<string>>(KEY_ENV.keyJson)
        : undefined;
    if (runtime === undefined || keyJson === undefined) {
      return yield* operation as Effect.Effect<Op>;
    }
    const region = yield* runtime.get<string>(KEY_ENV.region);
    const credentials = yield* credentialsFromKey(
      Redacted.isRedacted(keyJson) ? Redacted.value(keyJson) : keyJson,
      region,
    );
    return yield* (operation as Effect.Effect<Op>).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
      ),
    );
  });

/**
 * A distilled operation as {@link makeHttpBinding} takes it. Its requirements
 * are resolved once by {@link withCredentials}, so the runtime callable doesn't
 * leak them.
 */
export type StackitHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  StackitOpContext
>;

/**
 * Build the implementation of a resource-scoped binding over one distilled
 * operation: it grants on the host at deploy, and its runtime callable injects
 * the bound resource's identifiers into each request. Wrap it per resource in
 * the service's unexported `BindingHttp.ts`, so each `<Op>Http.ts` is a one-line
 * `Layer.effect(Cap, make…HttpBinding({ … }))`.
 */
export const makeHttpBinding = <
  R extends { readonly LogicalId: string },
  I,
  A,
  E,
  K extends keyof I,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.DNS.GetZone`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitHttpOp<I, A, E>;
  /** The request fields the bound resource supplies, as its attributes. */
  identify: (resource: R) => { readonly [P in K]: Output.Output<any, never> };
  /** The role bindings the operation needs. Called at deploy only. */
  grants: (resource: R) => readonly Grant[];
}) =>
  Effect.gen(function* () {
    const bind = yield* Bind;
    const run = yield* withCredentials(options.operation);
    return Effect.fn(function* (resource: R) {
      const identifiers: Array<readonly [string, Output.Accessor<unknown>]> = [];
      for (const [field, output] of Object.entries<Output.Output<any, never>>(
        options.identify(resource),
      )) {
        const accessor = yield* output;
        identifiers.push([field, accessor]);
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({ grants: options.grants(resource) });
      }
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (request?: Omit<I, K>) {
        const fields: Record<string, unknown> = {};
        for (const [field, accessor] of identifiers) {
          fields[field] = yield* accessor;
        }
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        return yield* run({ ...request, ...fields } as unknown as I);
      });
    });
  });
