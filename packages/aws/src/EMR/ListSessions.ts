import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListSessions` — lists the bound cluster's interactive sessions, optionally filtered by state.
 * ### Interactive Sessions
 * **Example:** List Idle Sessions
 * ```typescript
 * const listSessions = yield* AWS.EMR.ListSessions(cluster);
 *
 * const { Sessions } = yield* listSessions({ SessionStates: ["IDLE"] });
 * ```
 *
 * @binding
 */
export interface ListSessions extends Binding.Service<
  ListSessions,
  "AWS.EMR.ListSessions",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListSessionsInput, "ClusterId">,
    ) => Effect.Effect<SVC.ListSessionsOutput, SVC.ListSessionsError>
  >
> {}
export const ListSessions = Binding.Service<ListSessions>("AWS.EMR.ListSessions");

export const ListSessionsHttp = Layer.effect(
  ListSessions,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ListSessions",
    operation: emr.listSessions,
    actions: ["elasticmapreduce:ListSessions"],
  }),
);
