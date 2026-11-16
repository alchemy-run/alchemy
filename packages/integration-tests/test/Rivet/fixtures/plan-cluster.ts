/**
 * A cluster for tests that only plan. Its namespace waits on a resource the
 * plan creates, as a real control plane's does, so planning never reaches
 * out to the control plane to read the pool.
 */
import * as Rivet from "@alchemy.run/rivet";
import type { ClusterShape } from "@alchemy.run/rivet/Cluster";
import { adminToken } from "@alchemy.run/rivet/internal/AdminToken";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const planCluster = (shape: Omit<ClusterShape, "token" | "namespace">) =>
  Layer.effect(
    Rivet.Cluster,
    Effect.gen(function* () {
      const token = yield* adminToken("Plan");
      return {
        ...shape,
        token: token.text,
        namespace: token.text.pipe(Output.map(() => "default")),
      };
    }),
  );
