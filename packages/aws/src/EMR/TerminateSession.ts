import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:TerminateSession` — terminates an interactive session on the bound cluster.
 * ### Interactive Sessions
 * **Example:** Terminate a Session
 * ```typescript
 * const terminateSession = yield* AWS.EMR.TerminateSession(cluster);
 *
 * yield* terminateSession({ SessionId: sessionId });
 * ```
 *
 * @binding
 */
export interface TerminateSession extends Binding.Service<
  TerminateSession,
  "AWS.EMR.TerminateSession",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.TerminateSessionInput, "ClusterId">,
    ) => Effect.Effect<SVC.TerminateSessionOutput, SVC.TerminateSessionError>
  >
> {}
export const TerminateSession = Binding.Service<TerminateSession>("AWS.EMR.TerminateSession");

export const TerminateSessionHttp = Layer.effect(
  TerminateSession,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.TerminateSession",
    operation: emr.terminateSession,
    actions: ["elasticmapreduce:TerminateSession"],
  }),
);
