import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeRegionHttpBinding } from "./BindingHttp.ts";
import { ListProviderOptions } from "./ListProviderOptions.ts";

/**
 * HTTP implementation of {@link ListProviderOptions}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.ListProviderOptions
 */
export const ListProviderOptionsHttp = Layer.effect(
  ListProviderOptions,
  makeRegionHttpBinding({
    tag: "Stackit.UnifiedFirewall.ListProviderOptions",
    operation: ufw.listProviderOptions,
  }),
);
