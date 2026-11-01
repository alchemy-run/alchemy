import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import {
  type HarborCredentialsInput,
  listAllPages,
  ROBOT_NAME_MAX_LENGTH,
  withHarbor,
} from "./internal.ts";

/** One thing a robot may do in its project, in Harbor's RBAC terms. */
export interface RobotPermission {
  /**
   * Harbor resource: `repository`, `artifact`, `tag`, `scan`,
   * `artifact-addition`, `robot`, ...
   */
  resource: string;
  /** Harbor action: `pull`, `push`, `list`, `read`, `create`, `delete`, `stop`, ... */
  action: string;
}

export interface RobotAccountProps {
  /**
   * Name of the registry project the robot belongs to (a
   * {@link Project}'s `name`). A robot can't move: changing it replaces the
   * robot.
   */
  project: string;
  /**
   * URL of the registry (a {@link Project}'s `url`). Changing it replaces the
   * robot.
   */
  registryUrl: string;
  /**
   * The identity that creates, updates and deletes this robot on the registry's
   * own API, which doesn't take STACKIT credentials: a Harbor user's CLI secret
   * (user profile, in the registry UI), or another robot holding `robot`
   * permissions in the project and at least everything this one is granted.
   * It stays in Alchemy's state because `delete` needs it, so give it no more
   * than this takes. Changing it doesn't touch the robot.
   */
  credentials: HarborCredentialsInput;
  /**
   * Short name of the robot. Harbor logs it in as `robot$<project>+<name>`, the
   * `robotName` attribute. Lowercase letters, digits and single `.`, `_` or `-`
   * separators. Changing it replaces the robot.
   *
   * If omitted, a unique name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * What the robot may do in its project. Updates in place.
   *
   * @default repository pull and push
   */
  permissions?: RobotPermission[];
  /**
   * Days until the robot's secret stops working, counted from the robot's
   * creation, or `-1` for never. Updates in place.
   *
   * @default -1
   */
  durationDays?: number;
  /** Description of the robot. Updates in place. */
  description?: string;
  /**
   * Stop the robot from logging in, without deleting it. Updates in place.
   *
   * @default false
   */
  disabled?: boolean;
}

export interface RobotAccountAttributes {
  /** Harbor id of the robot. */
  robotId: number;
  /** The username to log in with: `robot$<project>+<name>`. */
  robotName: string;
  /** Short name of the robot. */
  name: string;
  /**
   * The robot's secret, the password to log in with. Harbor returns it only
   * when it is created; Alchemy keeps it in state.
   */
  secret: Redacted.Redacted<string>;
  /** Name of the registry project the robot belongs to. */
  project: string;
  /** URL of the registry. */
  registryUrl: string;
  /** What the robot may do in its project. */
  permissions: RobotPermission[];
  /** Days from creation until the secret stops working, or `-1` for never. */
  durationDays: number;
  /** Description of the robot, if any. */
  description: string | undefined;
  /** Whether the robot is prevented from logging in. */
  disabled: boolean;
  /** Epoch seconds when the secret stops working, or `-1` for never. */
  expiresAt: number;
}

export type RobotAccount = Resource<
  "Stackit.ContainerRegistry.RobotAccount",
  RobotAccountProps,
  RobotAccountAttributes,
  never,
  Providers
>;

/**
 * A robot account of a STACKIT Container Registry project: the identity
 * non-interactive `docker push` and `docker pull` log in with, and the one
 * the registry's image bindings (`ListRepositories`, `ListArtifacts`, ...) sign
 * with.
 *
 * Robots live on the registry's own Harbor API, which uses HTTP Basic rather than
 * STACKIT credentials. So you pass the identity that manages the robot in
 * `credentials`, and Alchemy doesn't mint one for you.
 *
 * The secret is returned once, and kept in Alchemy's state as a `Redacted`
 * value. When Alchemy finds a robot it has no secret for (it took over a robot,
 * or crashed before saving it), it asks Harbor for a new secret, so anything
 * still using the old one stops working.
 *
 * Ownership: robots have no labels. A robot is Alchemy's when it is in state or
 * carries a generated name. One with an explicit `name` that Alchemy didn't create
 * is reported as unowned and only taken over with `--adopt`. `alchemy unsafe nuke`
 * doesn't enumerate robots, because listing them takes a Harbor identity; they go
 * when their registry project does.
 *
 * ### Creating a Robot
 * **Example:** Robot that pushes and pulls
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const robot = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: project.name,
 *   registryUrl: project.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * // robot.robotName and robot.secret are the docker login.
 * ```
 *
 * **Example:** Pull-only robot that expires
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const robot = yield* Stackit.ContainerRegistry.RobotAccount("Puller", {
 *   project: project.name,
 *   registryUrl: project.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 *   name: "puller",
 *   durationDays: 90,
 *   permissions: [{ resource: "repository", action: "pull" }],
 * });
 * ```
 *
 * ### Pushing and Pulling Images
 * **Example:** Build, push and mirror with `@alchemy.run/docker`
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const robot = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: project.name,
 *   registryUrl: project.url,
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * const registry = {
 *   server: project.registryHost,
 *   username: robot.robotName,
 *   password: robot.secret,
 * };
 * const app = yield* Docker.Image("App", {
 *   name: Output.interpolate`${project.imagePrefix}/app`,
 *   tag: "1.0.0",
 *   registry,
 *   build: { context: "./app" },
 * });
 * const nginx = yield* Docker.RemoteImage("Nginx", {
 *   name: "nginx",
 *   tag: "alpine",
 *   targetName: Output.interpolate`${project.imagePrefix}/nginx`,
 *   registry,
 * });
 * ```
 *
 * ### Binding to a Runtime
 * **Example:** List the project's repositories from a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {});
 * export const Reader = Effect.gen(function* () {
 *   const project = yield* Images;
 *   return yield* Stackit.ContainerRegistry.RobotAccount("Reader", {
 *     project: project.name,
 *     registryUrl: project.url,
 *     credentials: {
 *       username: Config.String("HARBOR_USERNAME"),
 *       secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *     },
 *     permissions: [{ resource: "repository", action: "list" }],
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const reader = yield* Reader;
 *     const listRepositories = yield* Stackit.ContainerRegistry.ListRepositories(reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const repositories = yield* listRepositories({});
 *         return yield* HttpServerResponse.json({ repositories });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ListRepositoriesHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a robot gives it a new secret
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const project = yield* Stackit.ContainerRegistry.Project("Images", {});
 * // Changing `name`, `project` or `registryUrl` creates a new robot and deletes
 * // the old one. Update anything that holds the old login.
 * const robot = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: project.name,
 *   registryUrl: project.url,
 *   name: "pusher-v2",
 *   credentials: {
 *     username: Config.String("HARBOR_USERNAME"),
 *     secret: Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Container Registry
 * @category Containers
 */
export const RobotAccount = Resource<RobotAccount>("Stackit.ContainerRegistry.RobotAccount");

type Attributes = RobotAccount["Attributes"];

const DEFAULT_PERMISSIONS: readonly RobotPermission[] = [
  { resource: "repository", action: "pull" },
  { resource: "repository", action: "push" },
];

/** A robot's secret Alchemy doesn't hold: `read` found the robot without state. */
const UNKNOWN_SECRET = "";

const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: ROBOT_NAME_MAX_LENGTH });

/** A secret Harbor returned, or `undefined` when it returned none. */
const knownSecret = (secret: string | Redacted.Redacted<string> | undefined) => {
  if (secret === undefined) return undefined;
  const redacted = Redacted.isRedacted(secret) ? secret : Redacted.make(secret);
  return Redacted.value(redacted) === UNKNOWN_SECRET ? undefined : redacted;
};

/** `robot$<project>+<name>` -> `<name>`. Harbor rejects a `+` in a short name. */
const shortNameOf = (robotName: string) => robotName.slice(robotName.lastIndexOf("+") + 1);

const permissionKey = (permission: RobotPermission) =>
  `${permission.resource}:${permission.action}`;

/** The robot's access in its own project, as flat resource and action pairs. */
const observedPermissions = (robot: harbor.Robot): RobotPermission[] =>
  (robot.permissions ?? []).flatMap((permission) =>
    (permission.access ?? []).flatMap((access) =>
      access.resource === undefined || access.action === undefined
        ? []
        : [{ resource: access.resource, action: access.action }],
    ),
  );

/** The wire form of a robot's access: project level, in one project. */
const toWirePermissions = (project: string, permissions: readonly RobotPermission[]) => [
  {
    kind: "project",
    namespace: project,
    access: permissions.map((permission) => ({
      resource: permission.resource,
      action: permission.action,
    })),
  },
];

const toAttrs = (
  input: { readonly project: string; readonly registryUrl: string },
  robot: harbor.Robot,
  secret: Redacted.Redacted<string>,
): Attributes => ({
  robotId: robot.id!,
  robotName: robot.name!,
  name: shortNameOf(robot.name!),
  secret,
  project: input.project,
  registryUrl: input.registryUrl,
  permissions: observedPermissions(robot),
  durationDays: robot.duration ?? -1,
  description: robot.description === "" ? undefined : robot.description,
  disabled: robot.disable ?? false,
  expiresAt: robot.expires_at ?? -1,
});

const getRobotOrUndefined = (robotId: number) =>
  harbor.getRobot({ robot_id: robotId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * The robot with a short name in a registry project. Harbor only lists a
 * project's robots by the project's numeric id, and a missing project has none.
 */
const findRobotByName = (project: string, name: string) =>
  Effect.gen(function* () {
    const found = yield* harbor
      .getProject({ project_name_or_id: project, xIsResourceName: true })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
    if (found?.project_id === undefined) return undefined;
    const robots = yield* listAllPages(`robots of ${project}`, (page) =>
      harbor.listRobot({ q: `Level=project,ProjectID=${found.project_id}`, ...page }),
    );
    return robots.find((robot) => robot.name?.endsWith(`+${name}`));
  });

export const RobotAccountProvider = () =>
  Provider.succeed(RobotAccount, {
    stables: ["robotId", "robotName", "name", "project", "registryUrl"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the current one, and a project's robot
      // names are unique: it must be freed first. A generated name changes with
      // the new generation.
      if (hasUnresolvedTrigger<RobotAccountProps>(news, ["project", "registryUrl", "name"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<RobotAccountProps>(news, "name") !== undefined,
        } as const;
      }
      if (!isResolved(news)) return undefined;
      const sameName = (news.name ?? output.name) === output.name;
      if (!sameName || news.project !== output.project || news.registryUrl !== output.registryUrl) {
        return { action: "replace", deleteFirst: sameName && news.name !== undefined } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      // Harbor needs the identity in the props, which a read without them
      // doesn't have. Reconcile observes the robot itself on its first pass.
      if (olds?.credentials === undefined) return undefined;
      const registryUrl = output?.registryUrl ?? olds.registryUrl;
      const project = output?.project ?? olds.project;
      const signed = withHarbor(registryUrl, olds.credentials);
      if (output !== undefined) {
        const robot = yield* getRobotOrUndefined(output.robotId).pipe(signed);
        return robot === undefined ? undefined : toAttrs(output, robot, output.secret);
      }
      const name = olds.name ?? (yield* generatedName(id));
      const robot = yield* findRobotByName(project, name).pipe(signed);
      if (robot === undefined) return undefined;
      const attrs = toAttrs({ project, registryUrl }, robot, Redacted.make(UNKNOWN_SECRET));
      // No labels: it is ours when it carries the generated name, or is the
      // generation being replaced. A robot id is only unique in its registry.
      const isPrevious =
        previous !== undefined &&
        previous.robotId === robot.id &&
        previous.registryUrl === registryUrl;
      return olds.name === undefined || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project, registryUrl } = news;
      const signed = withHarbor(registryUrl, news.credentials);
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const permissions = news.permissions ?? DEFAULT_PERMISSIONS;
      const durationDays = news.durationDays ?? -1;

      // 1. Observe. `output` is a cache, and only counts while it still names
      // the desired robot. Without it, only a generated name proves the robot is
      // ours; an explicit one that exists comes through `read` and `--adopt`.
      const sameRobot =
        output?.project === project && output.registryUrl === registryUrl && output.name === name;
      let robot = sameRobot ? yield* getRobotOrUndefined(output.robotId).pipe(signed) : undefined;
      if (robot === undefined && news.name === undefined) {
        robot = yield* findRobotByName(project, name).pipe(signed);
      }

      // 2. Ensure.
      let secret = sameRobot ? knownSecret(output.secret) : undefined;
      if (robot === undefined) {
        const created = yield* harbor
          .createRobot({
            name,
            level: "project",
            duration: durationDays,
            disable: news.disabled ?? false,
            permissions: toWirePermissions(project, permissions),
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(
            signed,
            // A concurrent create of a generated name won the race: observe it.
            // An explicit name that's taken belongs to someone else.
            Effect.catchTag("Conflict", (error) =>
              news.name !== undefined
                ? Effect.fail(error)
                : findRobotByName(project, name).pipe(
                    signed,
                    Effect.flatMap((found) =>
                      found === undefined ? Effect.fail(error) : Effect.succeed(found),
                    ),
                  ),
            ),
          );
        secret = knownSecret(created.secret);
        robot = yield* harbor.getRobot({ robot_id: created.id! }).pipe(signed);
      }
      const robotId = robot.id!;

      // 3. Sync: every mutable aspect goes in one PUT, diffed against the
      // observed robot. Harbor refuses a PUT with a different name, so it sends
      // back the one it reports.
      if (
        (news.description !== undefined && (robot.description ?? "") !== news.description) ||
        (robot.duration ?? -1) !== durationDays ||
        (robot.disable ?? false) !== (news.disabled ?? false) ||
        !sameMembers(observedPermissions(robot).map(permissionKey), permissions.map(permissionKey))
      ) {
        yield* harbor
          .updateRobot({
            robot_id: robotId,
            name: robot.name,
            level: "project",
            duration: durationDays,
            disable: news.disabled ?? false,
            permissions: toWirePermissions(project, permissions),
            description: news.description ?? robot.description,
          })
          .pipe(signed);
      }

      // A robot with no secret we know of can't be used: only a refresh gets one.
      if (secret === undefined) {
        const refreshed = yield* harbor.refreshSec({ robot_id: robotId, secret: "" }).pipe(signed);
        secret = knownSecret(refreshed.secret);
      }

      // 4. Return.
      const final = yield* harbor.getRobot({ robot_id: robotId }).pipe(signed);
      return toAttrs({ project, registryUrl }, final, secret ?? Redacted.make(UNKNOWN_SECRET));
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      yield* harbor.deleteRobot({ robot_id: output.robotId }).pipe(
        withHarbor(output.registryUrl, olds.credentials),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
