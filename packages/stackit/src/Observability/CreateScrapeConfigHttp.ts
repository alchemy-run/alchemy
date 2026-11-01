import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateScrapeConfig } from "./CreateScrapeConfig.ts";

/**
 * HTTP implementation of {@link CreateScrapeConfig}.
 *
 * @layer
 * @provides Stackit.Observability.CreateScrapeConfig
 */
export const CreateScrapeConfigHttp = Layer.effect(
  CreateScrapeConfig,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateScrapeConfig",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createScrapeConfig,
  }),
);
