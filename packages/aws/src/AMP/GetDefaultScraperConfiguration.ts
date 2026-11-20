import * as amp from "@distilled.cloud/aws/amp";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { decodeDefinition } from "./internal.ts";

/**
 * Runtime binding for `aps:GetDefaultScraperConfiguration`.
 *
 * An account-level binding — call it with no arguments to get a callable
 * that returns the AWS-managed default scraper configuration as Prometheus
 * scrape-configuration YAML text (decoded from the wire blob). Provide the
 * `GetDefaultScraperConfigurationHttp` layer on the Function to satisfy the
 * binding.
 *
 * ### Scraper Configuration
 * **Example:** Read the Default Scraper Configuration
 * ```typescript
 * const getDefaultScraperConfiguration =
 *   yield* AMP.GetDefaultScraperConfiguration();
 *
 * const yaml = yield* getDefaultScraperConfiguration();
 * ```
 *
 * @binding
 */
export interface GetDefaultScraperConfiguration extends Binding.Service<
  GetDefaultScraperConfiguration,
  "AWS.AMP.GetDefaultScraperConfiguration",
  () => Effect.Effect<() => Effect.Effect<string, amp.GetDefaultScraperConfigurationError>>
> {}
export const GetDefaultScraperConfiguration = Binding.Service<GetDefaultScraperConfiguration>(
  "AWS.AMP.GetDefaultScraperConfiguration",
);

export const GetDefaultScraperConfigurationHttp = Layer.effect(
  GetDefaultScraperConfiguration,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getDefaultScraperConfiguration = yield* AWSBindings.withCredentials(
      amp.getDefaultScraperConfiguration,
    );

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AMP.GetDefaultScraperConfiguration()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["aps:GetDefaultScraperConfiguration"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.AMP.GetDefaultScraperConfiguration")(function* () {
        const response = yield* getDefaultScraperConfiguration({});
        return yield* decodeDefinition(response.configuration);
      });
    });
  }),
);
