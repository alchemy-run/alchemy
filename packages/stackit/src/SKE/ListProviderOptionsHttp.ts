import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeRegionHttpBinding } from "./BindingHttp.ts";
import { ListProviderOptions } from "./ListProviderOptions.ts";

/**
 * HTTP implementation of {@link ListProviderOptions}.
 *
 * @layer
 * @provides Stackit.SKE.ListProviderOptions
 */
export const ListProviderOptionsHttp = Layer.effect(
  ListProviderOptions,
  makeRegionHttpBinding({
    tag: "Stackit.SKE.ListProviderOptions",
    operation: ske.listProviderOptions,
  }),
);
