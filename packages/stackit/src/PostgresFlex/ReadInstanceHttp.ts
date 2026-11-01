import * as Layer from "effect/Layer";
import {
  POSTGRES_READ_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadInstanceClient,
} from "./BindingHttp.ts";
import { ReadInstance } from "./ReadInstance.ts";

/**
 * HTTP implementation of {@link ReadInstance}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.ReadInstance
 */
export const ReadInstanceHttp = Layer.effect(
  ReadInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.PostgresFlex.ReadInstance",
    access: POSTGRES_READ_ACCESS,
    makeClient: makeReadInstanceClient,
  }),
);
