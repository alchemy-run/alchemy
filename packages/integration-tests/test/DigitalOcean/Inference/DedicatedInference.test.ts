import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getDedicatedInference, listVpcs } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isGone, logLevel, skipSlow } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "nyc2";
const GPU = "gpu-h100x1-80gb";

// One GPU for the life of the test (an H100 is ≈ $4.41/hour); provisioning and
// loading weights take ten to thirty minutes.
test.provider.skipIf(skipSlow)(
  "dedicated inference: serve a model on one GPU and answer a chat completion, or refuse with GpuPlanUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The region's default VPC: the first VPC in a region becomes its
      // default and can never be deleted, so the test doesn't create one.
      const vpcs = yield* listVpcs.items({ per_page: 200 }).pipe(Stream.runCollect);
      const defaultVpc = vpcs.find((v) => v.region === REGION && v.default);
      if (defaultVpc === undefined) return yield* Effect.die(`no default VPC in ${REGION}`);
      const vpcId = defaultVpc.id;
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const llm = yield* DigitalOcean.Inference.DedicatedInference("Llm", {
              region: REGION,
              vpcId,
              publicEndpoint: true,
              models: [
                {
                  model: "mistralai/Mistral-7B-Instruct-v0.3",
                  accelerators: [{ gpu: GPU }],
                },
              ],
            });
            return {
              id: llm.dedicatedInferenceId,
              endpoint: llm.publicEndpoint,
              token: llm.token,
            };
          }),
        )
        .pipe(Effect.result);

      if (Result.isFailure(result)) {
        // No region has the GPU plan right now: the refusal is typed, and
        // nothing was created or billed.
        expect(String(result.failure)).toContain("GpuPlanUnavailable");
        yield* stack.destroy();
      } else {
        const deployed = result.success;
        expect(deployed.endpoint).toMatch(/\./);
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
      }
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:inference", "live"],
    timeout: 3_600_000,
  },
);
