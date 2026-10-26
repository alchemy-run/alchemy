import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Project } from "./Project.ts";

/**
 * Shared scaffolding for the Dev Center data-plane bindings (Microsoft Dev
 * Box and Azure Deployment Environments): resolves the distilled
 * `devcenter-data` operation once when the layer is built, injects the
 * bound project's dev center endpoint and project name, and assigns the
 * binding's custom role on that project at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const PROJECTS = "Microsoft.DevCenter/projects";

/** Dev Center project actions the data plane checks for reads. */
export const DevCenterAction = {
  readProject: `${PROJECTS}/read`,
  readPools: `${PROJECTS}/pools/read`,
  readSchedules: `${PROJECTS}/pools/schedules/read`,
  readCatalogs: `${PROJECTS}/catalogs/read`,
  readEnvironmentDefinitions: `${PROJECTS}/catalogs/environmentDefinitions/read`,
  readEnvironmentTypes: `${PROJECTS}/environmentTypes/read`,
  readImageBuilds: `${PROJECTS}/catalogs/imageDefinitions/builds/read`,
} as const;

/** Dev Center data actions for the caller's own dev boxes and environments. */
export const DevCenterDataAction = {
  devBoxRead: `${PROJECTS}/users/devboxes/userRead/action`,
  devBoxWrite: `${PROJECTS}/users/devboxes/userWrite/action`,
  devBoxDelete: `${PROJECTS}/users/devboxes/userDelete/action`,
  devBoxStart: `${PROJECTS}/users/devboxes/userStart/action`,
  devBoxStop: `${PROJECTS}/users/devboxes/userStop/action`,
  devBoxRemoteConnection: `${PROJECTS}/users/devboxes/userGetRemoteConnection/action`,
  devBoxActionRead: `${PROJECTS}/users/devboxes/userActionRead/action`,
  devBoxActionManage: `${PROJECTS}/users/devboxes/userActionManage/action`,
  devBoxCustomize: `${PROJECTS}/users/devboxes/userCustomize/action`,
  environmentRead: `${PROJECTS}/users/environments/userRead/action`,
  environmentWrite: `${PROJECTS}/users/environments/userWrite/action`,
  environmentDelete: `${PROJECTS}/users/environments/userDelete/action`,
  environmentOutputsRead: `${PROJECTS}/users/environments/userOutputsRead/action`,
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound project) with
 * exactly `actions` and `dataActions`. Bindings with the same permissions
 * share one role.
 */
export interface DevCenterGrant {
  readonly role: string;
  readonly actions: readonly string[];
  readonly dataActions?: readonly string[];
}

const A = DevCenterAction;
const D = DevCenterDataAction;

/**
 * The custom roles the bindings assign; the logical ID is
 * `AzureDevCenter<role>Role`. Every role carries `projects/read`: the data
 * plane resolves the project before any other check. The built-in **DevCenter
 * Dev Box User** and **Deployment Environments User** also grant
 * `projects/*\/read` and every other dev box or environment data action.
 */
export const DevCenterRole = {
  ProjectRead: { role: "ProjectRead", actions: [A.readProject] },
  PoolRead: { role: "PoolRead", actions: [A.readProject, A.readPools] },
  ScheduleRead: { role: "ScheduleRead", actions: [A.readProject, A.readSchedules] },
  CatalogRead: { role: "CatalogRead", actions: [A.readProject, A.readCatalogs] },
  EnvironmentDefinitionRead: {
    role: "EnvironmentDefinitionRead",
    actions: [A.readProject, A.readEnvironmentDefinitions],
  },
  EnvironmentTypeRead: {
    role: "EnvironmentTypeRead",
    actions: [A.readProject, A.readEnvironmentTypes],
  },
  DevBoxRead: { role: "DevBoxRead", actions: [A.readProject], dataActions: [D.devBoxRead] },
  DevBoxWrite: {
    role: "DevBoxWrite",
    actions: [A.readProject, A.readPools],
    dataActions: [D.devBoxWrite],
  },
  DevBoxDelete: { role: "DevBoxDelete", actions: [A.readProject], dataActions: [D.devBoxDelete] },
  DevBoxStart: { role: "DevBoxStart", actions: [A.readProject], dataActions: [D.devBoxStart] },
  DevBoxStop: { role: "DevBoxStop", actions: [A.readProject], dataActions: [D.devBoxStop] },
  DevBoxRestart: {
    role: "DevBoxRestart",
    actions: [A.readProject],
    dataActions: [D.devBoxStart, D.devBoxStop],
  },
  DevBoxRemoteConnection: {
    role: "DevBoxRemoteConnection",
    actions: [A.readProject],
    dataActions: [D.devBoxRemoteConnection],
  },
  /** Repair, capture a snapshot of, or restore a snapshot onto an existing dev box. */
  DevBoxManage: { role: "DevBoxManage", actions: [A.readProject], dataActions: [D.devBoxWrite] },
  DevBoxActionRead: {
    role: "DevBoxActionRead",
    actions: [A.readProject],
    dataActions: [D.devBoxActionRead],
  },
  DevBoxActionManage: {
    role: "DevBoxActionManage",
    actions: [A.readProject],
    dataActions: [D.devBoxActionManage],
  },
  /** Apply (or validate) catalog customization tasks; tasks resolve through the project's catalogs. */
  DevBoxCustomize: {
    role: "DevBoxCustomize",
    actions: [A.readProject, A.readCatalogs],
    dataActions: [D.devBoxCustomize],
  },
  ImageBuildRead: { role: "ImageBuildRead", actions: [A.readProject, A.readImageBuilds] },
  EnvironmentRead: {
    role: "EnvironmentRead",
    actions: [A.readProject],
    dataActions: [D.environmentRead],
  },
  EnvironmentWrite: {
    role: "EnvironmentWrite",
    actions: [A.readProject, A.readCatalogs, A.readEnvironmentDefinitions, A.readEnvironmentTypes],
    dataActions: [D.environmentWrite],
  },
  EnvironmentDelete: {
    role: "EnvironmentDelete",
    actions: [A.readProject],
    dataActions: [D.environmentDelete],
  },
  EnvironmentOutputsRead: {
    role: "EnvironmentOutputsRead",
    actions: [A.readProject],
    dataActions: [D.environmentOutputsRead],
  },
} as const satisfies Record<string, DevCenterGrant>;

/** Assign `grants` on the project to the host, creating the custom roles they name. */
const GrantDevCenterRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, project: Project, grants: readonly DevCenterGrant[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const permissions = [...grant.actions, ...(grant.dataActions ?? [])];
        const role = yield* AzureRoleDefinition(`AzureDevCenter${grant.role}Role`, {
          description: `Alchemy Dev Center binding: ${permissions.join(", ")}`,
          permissions: [
            {
              actions: [...grant.actions],
              dataActions: grant.dataActions === undefined ? undefined : [...grant.dataActions],
            },
          ],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope: project.projectId });
      }
      yield* bind`${tag}(${project})`({ roleAssignments });
    }
  });
});

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/** Where a project's data plane lives, resolved per call at runtime. */
const projectAddressOf = Effect.fn(function* (project: Project) {
  const devCenterUri = yield* project.devCenterUri;
  const projectName = yield* project.projectName;
  return Effect.all({ endpoint: devCenterUri, projectName }).pipe(
    Effect.map(({ endpoint, projectName }) => ({ endpoint: endpoint ?? "", projectName })),
  );
});

/**
 * Build the impl Effect for a project-scoped operation whose request
 * carries `endpoint` + `projectName` (pools, schedules, catalogs,
 * environment definitions, environment types, all environments): the
 * runtime callable injects the bound {@link Project}'s dev center endpoint
 * and name, and the deploy-time half assigns `grants` on the project.
 */
export const makeProjectHttpBinding = <
  I extends { endpoint: string; projectName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.DevCenter.ListPools`. */
  tag: string;
  /** The distilled operation; the endpoint and project name are injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Roles assigned on the project. */
  grants: readonly DevCenterGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDevCenterRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (project: Project) {
      yield* grant(options.tag, project, options.grants);
      const address = yield* projectAddressOf(project);
      return Effect.fn(`${options.tag}(${project.LogicalId})`)(function* (
        request?: Omit<I, "endpoint" | "projectName">,
      ) {
        const where = yield* address;
        // `Omit<I, "endpoint" | "projectName"> & { endpoint, projectName }`
        // is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

/**
 * Build the impl Effect for a per-user operation whose request carries
 * `endpoint` + `projectName` + `userId` (dev boxes, environments, project
 * abilities): like {@link makeProjectHttpBinding}, and `userId` defaults to
 * `"me"`, the host's own identity.
 */
export const makeProjectUserHttpBinding = <
  I extends { endpoint: string; projectName: string; userId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.DevCenter.ListDevBoxes`. */
  tag: string;
  /** The distilled operation; the endpoint, project name and user are injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Roles assigned on the project. */
  grants: readonly DevCenterGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDevCenterRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (project: Project) {
      yield* grant(options.tag, project, options.grants);
      const address = yield* projectAddressOf(project);
      return Effect.fn(`${options.tag}(${project.LogicalId})`)(function* (
        request?: Omit<I, "endpoint" | "projectName" | "userId"> & { userId?: string },
      ) {
        const where = yield* address;
        // The request plus the injected members is `I`, but TypeScript
        // cannot prove it for a generic `I`.
        return yield* op({ ...request, userId: request?.userId ?? "me", ...where } as I);
      });
    });
  });
