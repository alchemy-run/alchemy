import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListScrapeConfigs } from "./ListScrapeConfigs.ts";

/**
 * HTTP implementation of {@link ListScrapeConfigs}.
 *
 * @layer
 * @provides Stackit.Observability.ListScrapeConfigs
 */
export const ListScrapeConfigsHttp = Layer.effect(
  ListScrapeConfigs,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListScrapeConfigs",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listScrapeConfigs,
  }),
);
