import * as edge from "@distilled.cloud/stackit/edge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EDGE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetKubeconfig, type GetKubeconfigRequest } from "./GetKubeconfig.ts";
import type { Instance } from "./Instance.ts";
import { kubeconfigText } from "./internal.ts";

/**
 * HTTP implementation of {@link GetKubeconfig}.
 *
 * @layer
 * @provides Stackit.EdgeCloud.GetKubeconfig
 */
export const GetKubeconfigHttp = Layer.effect(
  GetKubeconfig,
  Effect.gen(function* () {
    const bindInstance = yield* makeInstanceHttpBinding({
      tag: "Stackit.EdgeCloud.GetKubeconfig",
      access: EDGE_ACCESS.mintCredential,
      operation: edge.getKubeconfigByInstanceId,
    });
    return Effect.fn(function* (instance: Instance) {
      const getKubeconfig = yield* bindInstance(instance);
      return (request?: GetKubeconfigRequest) =>
        getKubeconfig(request).pipe(
          Effect.map((response) => ({ kubeconfig: kubeconfigText(response.kubeconfig) })),
        );
    });
  }),
);
