import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getDedicatedInference } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// One MI300X for the life of the test (≈ $2.59/hour); provisioning and
// loading weights take ten to thirty minutes.
test.provider.skipIf(skipSlow)(
  "dedicated inference: serve a model on one GPU, answer a chat completion, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* DigitalOcean.Vpc("Vpc", { region: "atl1", ipRange: "10.61.0.0/20" });
          const llm = yield* DigitalOcean.Inference.DedicatedInference("Llm", {
            region: "atl1",
            vpcId: vpc.vpcId,
            publicEndpoint: true,
            models: [
              {
                model: "mistralai/Mistral-7B-Instruct-v0.3",
                accelerators: [{ gpu: "gpu-mi300x1-192gb" }],
              },
            ],
          });
          return {
            id: llm.dedicatedInferenceId,
            endpoint: llm.publicEndpoint,
            token: llm.token,
          };
        }),
      );
      expect(deployed.endpoint).toBeDefined();
      expect(deployed.token).toBeDefined();

      const client = yield* HttpClient.HttpClient;
      const reply = yield* client
        .execute(
          HttpClientRequest.post(`https://${deployed.endpoint}/v1/chat/completions`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(deployed.token!)),
            HttpClientRequest.bodyJsonUnsafe({
              model: "mistralai/Mistral-7B-Instruct-v0.3",
              messages: [{ role: "user", content: "Reply with the word pong." }],
              max_tokens: 5,
            }),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`HTTP ${response.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
        );
      expect(JSON.stringify(reply).toLowerCase()).toContain("pong");

      yield* stack.destroy();
      expect(
        yield* isGone(getDedicatedInference({ dedicated_inference_id: deployed.id })).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (gone) => gone,
            times: 30,
          }),
        ),
      ).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:inference", "live"],
    timeout: 3_600_000,
  },
);
