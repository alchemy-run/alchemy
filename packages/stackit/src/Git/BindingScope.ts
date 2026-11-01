import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";

/**
 * What a binding on a whole project binds to: any resource with a `projectId`
 * attribute, such as a `Stackit.Git.Instance` or a `Stackit.ResourceManager.Project`. It
 * names the project to work in and the project the role is granted on, so a host can
 * list instances without this stack managing one.
 */
export type BindingScope = ResourceLike & {
  /** Project to work in. */
  readonly projectId: Output.Output<string, never>;
};
