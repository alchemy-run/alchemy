import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpsertScrapeConfigs } from "./UpsertScrapeConfigs.ts";

/**
 * HTTP implementation of {@link UpsertScrapeConfigs}.
 *
 * @layer
 * @provides Stackit.Observability.UpsertScrapeConfigs
 */
export const UpsertScrapeConfigsHttp = Layer.effect(
  UpsertScrapeConfigs,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpsertScrapeConfigs",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.partialUpdateScrapeConfigs,
  }),
);
