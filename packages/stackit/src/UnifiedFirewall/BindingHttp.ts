import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import type { Folder } from "../ResourceManager/Folder.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { ReadRulesClient } from "./ReadRules.ts";
import type { ReadWriteRulesClient } from "./ReadWriteRules.ts";
import type { WriteRulesClient } from "./WriteRules.ts";

/**
 * Shared HTTP scaffolding for Unified Firewall bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the rules: STACKIT has no role binding on a single rule (see
 * `StackitBindings`). The permissions come from the spec's `x-stackit-authorization` on each
 * operation.
 */
export const READ_RULES_ACCESS: StackitBindings.Access = {
  permissions: ["ufw.instance.get", "ufw.instance.list"],
};
export const WRITE_RULES_ACCESS: StackitBindings.Access = {
  permissions: ["ufw.instance.create", "ufw.instance.update", "ufw.instance.delete"],
};
export const READ_WRITE_RULES_ACCESS: StackitBindings.Access = {
  permissions: [
    "ufw.instance.get",
    "ufw.instance.list",
    "ufw.instance.create",
    "ufw.instance.update",
    "ufw.instance.delete",
  ],
};

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.UnifiedFirewall.GetRule`. */
  tag: string;
  /** What the operation needs on the bound scope. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound scope's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on the rules of a project and region. The API calls the region `regionId`. */
export const makeRulesHttpBinding = <I extends { projectId: string; regionId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({ projectId: scope.projectId, regionId: scope.region }),
    grants: (scope) => [StackitBindings.grantOn(scope, options.access)],
  });

/**
 * A binding on a region. The spec turns authorization off for it, so nothing is granted. The
 * host still gets a service account and key, to sign with.
 */
export const makeRegionHttpBinding = <I extends { regionId: string }, A, E>(
  options: Omit<HttpBindingOptions<I, A, E>, "access">,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({ regionId: scope.region }),
    grants: () => [],
  });

/** A binding on a folder, granted on the folder itself. Requests name it by its UUID. */
export const makeFolderHttpBinding = <I extends { folderId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (folder: Folder) => ({ folderId: folder.folderId }),
    grants: (folder) => [
      StackitBindings.grantOnScope(
        { resourceType: "folder", resourceId: folder.folderId },
        options.access,
      ),
    ],
  });

/** A bound scope's identifiers, read when a call runs. */
interface RuleScopeIdentifiers {
  readonly projectId: Effect.Effect<string>;
  readonly region: Effect.Effect<string>;
}

type RuleRequest<I> = Omit<I, "projectId" | "regionId">;

/** Inject the scope's identifiers into every request of an operation. */
const onRules =
  (scope: RuleScopeIdentifiers) =>
  <I extends { projectId: string; regionId: string }, A, E>(
    run: (input: I) => Effect.Effect<A, E>,
  ) =>
    Effect.fnUntraced(function* (request?: RuleRequest<I>) {
      const projectId = yield* scope.projectId;
      const regionId = yield* scope.region;
      // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
      return yield* run({ ...request, projectId, regionId } as unknown as I);
    });

/** Build the read client. Its operations are resolved with the host's credentials once. */
export const makeReadRulesClient = Effect.gen(function* () {
  const getRule = yield* StackitBindings.withCredentials(ufw.getRule);
  const listRules = yield* StackitBindings.withCredentials(ufw.listRules);
  return (scope: RuleScopeIdentifiers): ReadRulesClient => {
    const on = onRules(scope);
    return { getRule: on(getRule), listRules: on(listRules) };
  };
});

/** Build the write client. Its operations are resolved with the host's credentials once. */
export const makeWriteRulesClient = Effect.gen(function* () {
  const createRule = yield* StackitBindings.withCredentials(ufw.createRule);
  const updateRule = yield* StackitBindings.withCredentials(ufw.updateRule);
  const deleteRule = yield* StackitBindings.withCredentials(ufw.deleteRule);
  return (scope: RuleScopeIdentifiers): WriteRulesClient => {
    const on = onRules(scope);
    return {
      createRule: on(createRule),
      updateRule: on(updateRule),
      deleteRule: on(deleteRule),
    };
  };
});

/** Build the client with every read and write operation on rules. */
export const makeReadWriteRulesClient = Effect.gen(function* () {
  const makeRead = yield* makeReadRulesClient;
  const makeWrite = yield* makeWriteRulesClient;
  return (scope: RuleScopeIdentifiers): ReadWriteRulesClient => ({
    ...makeRead(scope),
    ...makeWrite(scope),
  });
});

/** Build a binding whose client groups several operations: one grant, then the client. */
export const makeRulesClientHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.UnifiedFirewall.ReadRules`. */
  tag: string;
  /** What the client needs on the project holding the rules. */
  access: StackitBindings.Access;
  /** Build the client; resolved when the layer is built. */
  makeClient: Effect.Effect<(scope: RuleScopeIdentifiers) => Client>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (scope: BindingScope) {
      const projectId = yield* scope.projectId;
      const region = yield* scope.region;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${scope})`({
          grants: [StackitBindings.grantOn(scope, options.access)],
        });
      }
      return makeClient({ projectId, region });
    });
  });
