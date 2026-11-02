import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeConfigurationHttpBinding } from "./BindingHttp.ts";
import { UpdateConfiguration } from "./UpdateConfiguration.ts";

/**
 * HTTP implementation of {@link UpdateConfiguration}.
 *
 * @layer
 * @provides Stackit.WAF.UpdateConfiguration
 */
export const UpdateConfigurationHttp = Layer.effect(
  UpdateConfiguration,
  makeConfigurationHttpBinding({
    tag: "Stackit.WAF.UpdateConfiguration",
    access: { permissions: ["alb.waf.get", "alb.waf.update"] },
    // The PUT takes the whole configuration: send the labels it has, so a
    // runtime update can't drop Alchemy's ownership labels.
    operation: Effect.gen(function* () {
      const getWAF = yield* waf.getWAF;
      const updateWAF = yield* waf.updateWAF;
      return (input: waf.UpdateWAFRequest) =>
        Effect.gen(function* () {
          if (input.labels !== undefined) return yield* updateWAF(input);
          const { labels } = yield* getWAF({
            projectId: input.projectId,
            region: input.region,
            name: input.name,
          });
          return yield* updateWAF({ ...input, labels });
        });
    }),
  }),
);
