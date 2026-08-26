import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Ruleset } from "./Ruleset.ts";
import { TestRuleset, type TestRulesetRequest } from "./TestRuleset.ts";

/**
 * HTTP implementation of {@link TestRuleset}.
 *
 * @layer
 * @provides GCP.Firebaserules.TestRuleset
 */
export const TestRulesetHttp = Layer.effect(
  TestRuleset,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (ruleset: Ruleset) {
      const name = yield* ruleset.name;
      return Effect.fn(`GCP.Firebaserules.TestRuleset(${ruleset.LogicalId})`)(
        function* (request: TestRulesetRequest = {}) {
          return yield* firebaserules
            .testProjects({
              ...request,
              name: yield* name,
            })
            .pipe(
              Effect.provideService(Credentials, credentials),
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );
        },
      );
    });
  }),
);
