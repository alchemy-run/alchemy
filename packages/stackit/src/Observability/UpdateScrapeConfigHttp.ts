import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateScrapeConfig } from "./UpdateScrapeConfig.ts";

/**
 * HTTP implementation of {@link UpdateScrapeConfig}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateScrapeConfig
 */
export const UpdateScrapeConfigHttp = Layer.effect(
  UpdateScrapeConfig,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateScrapeConfig",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateScrapeConfig,
  }),
);
