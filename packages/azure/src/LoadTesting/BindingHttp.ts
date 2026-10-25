import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { LoadTest } from "./LoadTest.ts";
import type { PlaywrightWorkspace } from "./PlaywrightWorkspace.ts";

/**
 * Shared scaffolding for the Azure Load Testing and Azure Playwright
 * data-plane bindings: resolves the distilled operation once when the
 * layer is built, injects the bound resource's data-plane endpoint (and
 * workspace ID), and assigns the binding's custom role on that resource at
 * deploy time.
 *
 * NOT exported from `index.ts`.
 */

const LOAD_TESTS = "Microsoft.LoadTestService/loadtests";
const WORKSPACES = "Microsoft.LoadTestService/playwrightWorkspaces";

/** Azure Load Testing data actions (Azure RBAC). */
export const LoadTestDataAction = {
  readTest: `${LOAD_TESTS}/readTest/action`,
  writeTest: `${LOAD_TESTS}/writeTest/action`,
  deleteTest: `${LOAD_TESTS}/deleteTest/action`,
  startTest: `${LOAD_TESTS}/startTest/action`,
  stopTest: `${LOAD_TESTS}/stopTest/action`,
} as const;

/**
 * Azure Playwright workspace actions (Azure RBAC). The resource provider
 * has no data actions: the Playwright data plane checks these control-plane
 * actions on the workspace.
 */
export const PlaywrightAction = {
  read: `${WORKSPACES}/Read`,
  writeAccessTokens: `${WORKSPACES}/AccessTokens/Write`,
  readTestRuns: `${WORKSPACES}/TestRuns/Read`,
  writeTestRuns: `${WORKSPACES}/TestRuns/Write`,
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound resource) with
 * exactly `actions` and `dataActions`. Bindings with the same permissions
 * share one role.
 */
export interface LoadTestingGrant {
  readonly role: string;
  readonly actions?: readonly string[];
  readonly dataActions?: readonly string[];
}

const D = LoadTestDataAction;
const P = PlaywrightAction;

/**
 * The custom roles the bindings assign; the logical ID is
 * `AzureLoadTesting<role>Role`. The built-in **Load Test Reader**,
 * **Contributor** and **Owner** also grant `Microsoft.LoadTestService/*\/read`
 * on every load test resource and test profile; **Playwright Workspace
 * Contributor** also manages test runs and quotas. Each custom role has only
 * the permission its operations check.
 */
export const LoadTestingRole = {
  ReadTest: { role: "ReadTest", dataActions: [D.readTest] },
  WriteTest: { role: "WriteTest", dataActions: [D.writeTest] },
  DeleteTest: { role: "DeleteTest", dataActions: [D.deleteTest] },
  StartTest: { role: "StartTest", dataActions: [D.startTest] },
  StopTest: { role: "StopTest", dataActions: [D.stopTest] },
  PlaywrightRead: { role: "PlaywrightRead", actions: [P.read] },
  PlaywrightAccessTokens: { role: "PlaywrightAccessTokens", actions: [P.writeAccessTokens] },
  PlaywrightReadTestRuns: { role: "PlaywrightReadTestRuns", actions: [P.readTestRuns] },
  PlaywrightWriteTestRuns: { role: "PlaywrightWriteTestRuns", actions: [P.writeTestRuns] },
} as const satisfies Record<string, LoadTestingGrant>;

/** Assign `grants` on `scope` to the host, creating the custom roles they name. */
const GrantLoadTestingRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: ResourceLike,
    scope: Output.Output<string, never>,
    grants: readonly LoadTestingGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const permissions = [...(grant.actions ?? []), ...(grant.dataActions ?? [])];
        const role = yield* AzureRoleDefinition(`AzureLoadTesting${grant.role}Role`, {
          description: `Alchemy Load Testing binding: ${permissions.join(", ")}`,
          permissions: [
            {
              actions: grant.actions === undefined ? undefined : [...grant.actions],
              dataActions: grant.dataActions === undefined ? undefined : [...grant.dataActions],
            },
          ],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope });
      }
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build the impl Effect for a load-test operation (every
 * `loadtesting-data` operation): the runtime callable injects the bound
 * {@link LoadTest}'s data-plane endpoint, and the deploy-time half assigns
 * `grants` on the load test resource.
 */
export const makeLoadTestHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.LoadTesting.GetTest`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Roles assigned on the load test resource. */
  grants: readonly LoadTestingGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantLoadTestingRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (loadTest: LoadTest) {
      yield* grant(options.tag, loadTest, loadTest.loadTestId, options.grants);
      const dataPlaneUri = yield* loadTest.dataPlaneUri;
      return Effect.fn(`${options.tag}(${loadTest.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* dataPlaneUri;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url ?? "" } as I);
      });
    });
  });

/**
 * The Playwright service endpoint for a workspace's `dataplaneUri`
 * (`https://{region}.api.playwright.microsoft.com/playwrightworkspaces/{id}`):
 * `https://{region}.api.playwright.microsoft.com` for access tokens, or
 * `https://{region}.reporting.api.playwright.microsoft.com` for test runs
 * (the `api` host answers 400 `InvalidRequest` for `/test-runs`).
 */
const playwrightEndpointOf = (uri: string | undefined, service: PlaywrightService) => {
  if (uri === undefined) return "";
  const host = new URL(uri).host;
  return service === "reporting"
    ? `https://${host.replace(/^([^.]+)\.api\./, "$1.reporting.api.")}`
    : `https://${host}`;
};

/** Which Playwright service host an operation goes to. */
export type PlaywrightService = "api" | "reporting";

/**
 * Build the impl Effect for a Playwright workspace operation (every
 * `loadtesting-playwright` operation): the runtime callable injects the
 * bound {@link PlaywrightWorkspace}'s service endpoint and workspace ID, and
 * the deploy-time half assigns `grants` on the workspace.
 */
export const makePlaywrightWorkspaceHttpBinding = <
  I extends { endpoint: string; workspaceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.LoadTesting.ListPlaywrightTestRuns`. */
  tag: string;
  /** The distilled operation; the endpoint and workspace ID are injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Roles assigned on the workspace. */
  grants: readonly LoadTestingGrant[];
  /**
   * The host the operation goes to.
   * @default "api"
   */
  service?: PlaywrightService;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantLoadTestingRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    const service = options.service ?? "api";
    return Effect.fn(function* (workspace: PlaywrightWorkspace) {
      yield* grant(options.tag, workspace, workspace.playwrightWorkspaceId, options.grants);
      // Mapped per call: every Playwright binding on a host shares one
      // `dataplaneUri` binding, whichever host the operation goes to.
      const dataplaneUri = yield* workspace.dataplaneUri;
      const workspaceId = yield* workspace.workspaceId;
      return Effect.fn(`${options.tag}(${workspace.LogicalId})`)(function* (
        request?: Omit<I, "endpoint" | "workspaceId">,
      ) {
        const uri = yield* dataplaneUri;
        const id = yield* workspaceId;
        const url = playwrightEndpointOf(uri, service);
        // `Omit<I, "endpoint" | "workspaceId"> & { endpoint, workspaceId }` is
        // `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: url, workspaceId: id ?? "" } as I);
      });
    });
  });
