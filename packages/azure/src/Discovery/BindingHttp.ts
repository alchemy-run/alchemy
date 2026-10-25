import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Bookshelf } from "./Bookshelf.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Shared scaffolding for the Microsoft Discovery data-plane bindings
 * (bookshelf knowledge bases, workspace conversations, investigations,
 * tasks and tools): resolves the distilled `discovery-bookshelf` /
 * `discovery-workspace` operation once when the layer is built, injects the
 * bound resource's data-plane endpoint, and assigns the binding's role on
 * that resource at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const D = "Microsoft.Discovery";

/** Microsoft Discovery data actions (Azure RBAC). */
export const DiscoveryDataAction = {
  knowledgeBases: `${D}/bookshelf/knowledgebases/*`,
  knowledgeBasesDelete: `${D}/bookshelf/knowledgebases/delete`,
  conversationsRead: `${D}/workspaces/conversations/read`,
  conversationsWrite: `${D}/workspaces/conversations/write`,
  conversationsDelete: `${D}/workspaces/conversations/delete`,
  investigationsRead: `${D}/workspaces/projects/investigations/read`,
  investigationsWrite: `${D}/workspaces/projects/investigations/write`,
  investigationsDelete: `${D}/workspaces/projects/investigations/delete`,
  runTool: `${D}/workspaces/projects/runTool/action`,
  operationsRead: `${D}/workspaces/projects/operations/read`,
  operationsCancel: `${D}/workspaces/projects/operations/cancel/action`,
} as const;

/**
 * The role a binding assigns on the bound resource: a built-in role whose
 * data actions are exactly what the operation calls, or a custom role
 * (`Azure.Authorization.RoleDefinition`, one per stack, logical ID
 * `AzureDiscovery<role>Role`) when every built-in role grants more.
 */
export type DiscoveryGrant =
  | { readonly builtIn: string }
  | { readonly role: string; readonly dataActions: readonly string[] };

const A = DiscoveryDataAction;

/** The roles the Microsoft Discovery bindings assign. */
export const DiscoveryRole = {
  /**
   * Built-in **Microsoft Discovery Bookshelf Index Data Reader**:
   * `knowledgebases/read`, `knowledgebases/operations/read`,
   * `knowledgeBaseVersions/query/action`, and `bookshelves/read`.
   */
  KnowledgeBaseReader: { builtIn: "8ec773c5-7ce6-4b78-91d1-182f8faa536d" },
  /**
   * Custom role with `bookshelf/knowledgebases/*`: the provider publishes no
   * narrower write or indexing data action, and the built-in **Microsoft
   * Discovery Platform Contributor** grants `Microsoft.Discovery/*`.
   */
  KnowledgeBaseWrite: { role: "KnowledgeBaseWrite", dataActions: [A.knowledgeBases] },
  /** Custom role with `bookshelf/knowledgebases/delete` only. */
  KnowledgeBaseDelete: { role: "KnowledgeBaseDelete", dataActions: [A.knowledgeBasesDelete] },
  /** Custom role with `workspaces/conversations/read` only. */
  ConversationRead: { role: "ConversationRead", dataActions: [A.conversationsRead] },
  /** Custom role with `workspaces/conversations/write` only. */
  ConversationWrite: { role: "ConversationWrite", dataActions: [A.conversationsWrite] },
  /** Custom role with `workspaces/conversations/delete` only. */
  ConversationDelete: { role: "ConversationDelete", dataActions: [A.conversationsDelete] },
  /** Custom role with `workspaces/projects/investigations/read` only. */
  InvestigationRead: { role: "InvestigationRead", dataActions: [A.investigationsRead] },
  /** Custom role with `workspaces/projects/investigations/write` only. */
  InvestigationWrite: { role: "InvestigationWrite", dataActions: [A.investigationsWrite] },
  /** Custom role with `workspaces/projects/investigations/delete` only. */
  InvestigationDelete: { role: "InvestigationDelete", dataActions: [A.investigationsDelete] },
  /** Custom role with `workspaces/projects/runTool/action` only. */
  ToolRun: { role: "ToolRun", dataActions: [A.runTool] },
  /** Custom role with `workspaces/projects/operations/read` only. */
  ToolOperationRead: { role: "ToolOperationRead", dataActions: [A.operationsRead] },
  /** Custom role with `workspaces/projects/operations/cancel/action` only. */
  ToolOperationCancel: { role: "ToolOperationCancel", dataActions: [A.operationsCancel] },
} as const satisfies Record<string, DiscoveryGrant>;

/** Assign `grant` on `scope` to the host, creating its custom role. */
const GrantDiscoveryRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: ResourceLike,
    scope: Output.Output<string, never>,
    grant: DiscoveryGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      let roleDefinitionId: Input<string>;
      if ("builtIn" in grant) {
        roleDefinitionId = grant.builtIn;
      } else {
        const role = yield* AzureRoleDefinition(`AzureDiscovery${grant.role}Role`, {
          description: `Alchemy Microsoft Discovery binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleDefinitionId = role.roleDefinitionId;
      }
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId, scope },
      ];
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

interface DiscoveryBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Azure.Discovery.GetKnowledgeBase`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Role assigned on the bound resource. */
  grant: DiscoveryGrant;
}

/**
 * Build the impl Effect for a bookshelf operation (every
 * `discovery-bookshelf` operation): the runtime callable injects the bound
 * {@link Bookshelf}'s `bookshelfUri`, and the deploy-time half assigns
 * `grant` on the bookshelf.
 */
export const makeBookshelfHttpBinding = <I extends { endpoint: string }, A, E>(
  options: DiscoveryBindingOptions<I, A, E>,
) =>
  Effect.gen(function* () {
    const grant = yield* GrantDiscoveryRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (bookshelf: Bookshelf) {
      yield* grant(options.tag, bookshelf, bookshelf.bookshelfId, options.grant);
      const bookshelfUri = yield* bookshelf.bookshelfUri;
      return Effect.fn(`${options.tag}(${bookshelf.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const endpoint = yield* bookshelfUri;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: endpoint ?? "" } as I);
      });
    });
  });

/**
 * Build the impl Effect for a workspace operation (every
 * `discovery-workspace` operation): the runtime callable injects the bound
 * {@link Workspace}'s `workspaceApiUri`, and the deploy-time half assigns
 * `grant` on the workspace.
 */
export const makeWorkspaceHttpBinding = <I extends { endpoint: string }, A, E>(
  options: DiscoveryBindingOptions<I, A, E>,
) =>
  Effect.gen(function* () {
    const grant = yield* GrantDiscoveryRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (workspace: Workspace) {
      yield* grant(options.tag, workspace, workspace.workspaceId, options.grant);
      const workspaceApiUri = yield* workspace.workspaceApiUri;
      return Effect.fn(`${options.tag}(${workspace.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const endpoint = yield* workspaceApiUri;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: endpoint ?? "" } as I);
      });
    });
  });
