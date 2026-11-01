import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";

/**
 * What a binding on a whole project and region binds to: any resource with `projectId` and
 * `region` attributes, such as a `Gateway`, a `Connection`, or a `Stackit.IaaS.Network`. It
 * names the project to work in and the project the role is granted on, so a host can list
 * gateways without this stack managing one.
 */
export type BindingScope = ResourceLike & {
  /** Project to work in. */
  readonly projectId: Output.Output<string, never>;
  /** Region to work in. */
  readonly region: Output.Output<string, never>;
};
