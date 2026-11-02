import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { CreateKubeconfig } from "./CreateKubeconfig.ts";

/**
 * HTTP implementation of {@link CreateKubeconfig}.
 *
 * @layer
 * @provides Stackit.SKE.CreateKubeconfig
 */
export const CreateKubeconfigHttp = Layer.effect(
  CreateKubeconfig,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.CreateKubeconfig",
    access: SKE_ACCESS.createKubeconfig,
    operation: ske.createKubeconfig,
  }),
);
