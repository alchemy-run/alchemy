import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteScrapeConfig } from "./DeleteScrapeConfig.ts";

/**
 * HTTP implementation of {@link DeleteScrapeConfig}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteScrapeConfig
 */
export const DeleteScrapeConfigHttp = Layer.effect(
  DeleteScrapeConfig,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteScrapeConfig",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteScrapeConfig,
  }),
);
