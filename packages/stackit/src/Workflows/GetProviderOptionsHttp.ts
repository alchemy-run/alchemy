import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Layer from "effect/Layer";
import * as StackitBindings from "../StackitBindings.ts";
import { GetProviderOptions } from "./GetProviderOptions.ts";
import type { Instance } from "./Instance.ts";

/**
 * HTTP implementation of {@link GetProviderOptions}.
 *
 * @layer
 * @provides Stackit.Workflows.GetProviderOptions
 */
export const GetProviderOptionsHttp = Layer.effect(
  GetProviderOptions,
  StackitBindings.makeHttpBinding({
    tag: "Stackit.Workflows.GetProviderOptions",
    operation: workflows.getProviderOptions,
    identify: (instance: Instance) => ({ regionId: instance.region }),
    // The spec turns authorization off for this operation (`x-stackit-authorization.disabled`).
    grants: () => [],
  }),
);
