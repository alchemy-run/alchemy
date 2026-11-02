import type { HarborOpContext } from "@distilled.cloud/stackit/Protocol";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import { repositoryLabel, withHarbor } from "./internal.ts";
import type { Project } from "./Project.ts";
import type { RobotAccount } from "./RobotAccount.ts";

/**
 * Shared HTTP scaffolding for Container Registry bindings.
 * NOT exported from index.ts.
 *
 * Two APIs, two kinds of access:
 *
 * - Container Registry's management API takes a STACKIT identity. These bindings
 *   grant a custom role with the permission the spec names for the operation
 *   (`x-stackit-authorization`), on the project holding the registry project,
 *   because STACKIT has no role binding on anything narrower (see
 *   `StackitBindings`). The role is shared per permission set.
 * - The registry's own Harbor API takes a robot's login. These bindings bind to a
 *   `RobotAccount` and create nothing: the robot's name, secret and registry reach
 *   the host's env through the attributes it reads here, and what they allow is
 *   the robot's `permissions`.
 */

/** Build a binding over one operation on a registry project. */
export const makeProjectHttpBinding = <
  I extends { projectId: string; regionId: string; artifactoryId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ContainerRegistry.GetProject`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the project's location and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (project: Project) => ({
      projectId: project.projectId,
      regionId: project.region,
      artifactoryId: project.artifactoryId,
    }),
    grants: (project) => [StackitBindings.grantOn(project, { permissions: options.permissions })],
  });

/**
 * Build a binding over one operation on a registry project's STACKIT project and
 * region, which the bound project only supplies.
 */
export const makeLocationHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ContainerRegistry.ListProjects`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the project's location is injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (project: Project) => ({
      projectId: project.projectId,
      regionId: project.region,
    }),
    grants: (project) => [StackitBindings.grantOn(project, { permissions: options.permissions })],
  });

/**
 * Build a binding over one operation on the registry's Harbor API. The robot's
 * project is injected, and a request's `repository_name` may be Harbor's full
 * `<project>/<repository>` or the bare repository; it is encoded the way Harbor's
 * path wants it.
 */
export const makeHarborHttpBinding = <I extends { project_name: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ContainerRegistry.ListRepositories`. */
  tag: string;
  /** The distilled operation, called with the robot's login. */
  operation: (input: I) => Effect.Effect<A, E, HarborOpContext>;
}) =>
  Effect.succeed(
    Effect.fn(function* (robot: RobotAccount) {
      const username = yield* robot.robotName;
      const secret = yield* robot.secret;
      const registryUrl = yield* robot.registryUrl;
      const project = yield* robot.project;
      return Effect.fn(`${options.tag}(${robot.LogicalId})`)(function* (
        request?: Omit<I, "project_name">,
      ) {
        const projectName = yield* project;
        const url = yield* registryUrl;
        const login = yield* username;
        const password = yield* secret;
        const repository = (request as { repository_name?: string } | undefined)?.repository_name;
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        const input = {
          ...request,
          project_name: projectName,
          ...(repository !== undefined
            ? { repository_name: repositoryLabel(projectName, repository) }
            : {}),
        } as unknown as I;
        return yield* options.operation(input).pipe(
          withHarbor(url, {
            username: login,
            // A host's env can hand a secret back unwrapped, whatever its type says.
            secret: Redacted.isRedacted(password)
              ? password
              : Redacted.make(password as unknown as string),
          }),
          Effect.provide(FetchHttpClient.layer),
        );
      });
    }),
  );
