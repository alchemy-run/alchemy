import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteScrapeConfigs } from "./DeleteScrapeConfigs.ts";

/**
 * HTTP implementation of {@link DeleteScrapeConfigs}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteScrapeConfigs
 */
export const DeleteScrapeConfigsHttp = Layer.effect(
  DeleteScrapeConfigs,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteScrapeConfigs",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteScrapeConfigs,
  }),
);
