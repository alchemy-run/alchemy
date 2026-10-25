import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectRequest extends Omit<
  devcenter.GetDevCenterProjectRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read the bound Dev Center project (description, dev box limit) through the
 * dev center data plane from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterProjectReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`, on
 * the project only. The smallest built-in role, **DevCenter Dev Box User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetProjectHttp}.
 *
 * ### Calling GetProject
 * **Example:** GetProject from a Function
 * ```typescript
 * // init
 * const getProject = yield* Azure.DevCenter.GetProject(project);
 *
 * // runtime
 * const info = yield* getProject();
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetProject extends Binding.Service<
  GetProject,
  "Azure.DevCenter.GetProject",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: GetProjectRequest,
    ) => Effect.Effect<devcenter.Project, devcenter.GetDevCenterProjectError, RuntimeContext>
  >
> {}

export const GetProject = Binding.Service<GetProject>("Azure.DevCenter.GetProject");
