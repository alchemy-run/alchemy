import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateCustomizationGroupRequest extends Omit<
  devcenter.CreateDevBoxCustomizationGroupRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Apply a group of catalog customization tasks to a dev box in the bound Dev
 * Center project from any host. The tasks run on the dev box after the call
 * returns.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxCustomizeRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/read` and the data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userCustomize/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * `userId` defaults to `me`: the host acts on its own dev boxes. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`). Provide
 * {@link CreateCustomizationGroupHttp}.
 *
 * ### Calling CreateCustomizationGroup
 * **Example:** CreateCustomizationGroup from a Function
 * ```typescript
 * // init
 * const createCustomizationGroup = yield* Azure.DevCenter.CreateCustomizationGroup(project);
 *
 * // runtime
 * const group = yield* createCustomizationGroup({
 *   devBoxName: "ci-box",
 *   customizationGroupName: "tools",
 *   tasks: [{ name: "catalog/winget", parameters: { package: "Git.Git" } }],
 * });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface CreateCustomizationGroup extends Binding.Service<
  CreateCustomizationGroup,
  "Azure.DevCenter.CreateCustomizationGroup",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateCustomizationGroupRequest,
    ) => Effect.Effect<
      devcenter.CustomizationGroup,
      devcenter.CreateDevBoxCustomizationGroupError,
      RuntimeContext
    >
  >
> {}

export const CreateCustomizationGroup = Binding.Service<CreateCustomizationGroup>(
  "Azure.DevCenter.CreateCustomizationGroup",
);
