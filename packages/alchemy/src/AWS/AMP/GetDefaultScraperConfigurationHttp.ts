import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import { GetDefaultScraperConfiguration } from "./GetDefaultScraperConfiguration.ts";
import { decodeDefinition } from "./internal.ts";

export const GetDefaultScraperConfigurationHttp = Layer.effect(
  GetDefaultScraperConfiguration,
  Effect.gen(function* () {
    const getDefaultScraperConfiguration = yield* HostAccess.withCredentials(
      amp.getDefaultScraperConfiguration,
    );

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.AMP.GetDefaultScraperConfiguration()`({
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
