/** A control plane on Compute Engine and a pool on a Cloud Run worker pool. */
import * as IAM from "@alchemy.run/gcp/IAM";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The identity another stack's deploy would join the control plane as. */
export const TokenReader = IAM.ServiceAccount("TokenReader", { displayName: "Rivet token reader" });

export const Cluster = Layer.unwrap(
  Effect.gen(function* () {
    // Nodes read their token from their own environment.
    if (globalThis.__ALCHEMY_RUNTIME__) return RivetGCP.ComputeEngineControlPlane("Rivet");
    const reader = yield* TokenReader;
    return RivetGCP.ComputeEngineControlPlane("Rivet", {
      tokenReaders: [Output.interpolate`serviceAccount:${reader.email}`],
    });
  }),
);
export const Default = RivetGCP.CloudRunPool("Default").pipe(Layer.provide(Cluster));
