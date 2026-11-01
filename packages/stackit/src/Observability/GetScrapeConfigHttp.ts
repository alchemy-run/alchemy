import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetScrapeConfig } from "./GetScrapeConfig.ts";

/**
 * HTTP implementation of {@link GetScrapeConfig}.
 *
 * @layer
 * @provides Stackit.Observability.GetScrapeConfig
 */
export const GetScrapeConfigHttp = Layer.effect(
  GetScrapeConfig,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetScrapeConfig",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getScrapeConfig,
  }),
);
