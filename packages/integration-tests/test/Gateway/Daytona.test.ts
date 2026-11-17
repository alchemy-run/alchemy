import * as AWS from "@alchemy.run/aws";
import * as Daytona from "@alchemy.run/daytona";
import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as GatewayWire from "alchemy/Gateway";
import { unpackEnvValue } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed, expectNoCredential } from "./conformance/conformance.ts";
import GatewayedDaytona from "./fixtures/daytona.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Daytona.providers(), E2B.providers(), AWS.providers()),
});

const get = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
    ),
    // The preview proxy takes a few seconds to warm up.
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
    Effect.map((served) => served as unknown as Served),
  );

const options = {
  tags: ["provider:daytona", "provider:e2b", "provider:aws", "provider:aws:lambda", "live"],
  timeout: 900_000,
};

test.provider(
  "a Daytona sandbox holds no credential, and its gateway answers its token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(GatewayedDaytona);
      const env = (yield* get(`${sandbox.url}/env`)) as unknown as {
        apiKey: string | null;
        gateway: string;
        token: string;
      };
      expectNoCredential(env, { gatewayHost: ".on.aws" });

      // The gateway built this sandbox's bindings from its program: the call
      // the sandbox would make, sent from here with the sandbox's token.
      const token = Redacted.value(unpackEnvValue<Redacted.Redacted<string>>(env.token)!);
      const answer = yield* HttpClient.execute(
        HttpClientRequest.post(`${env.gateway}/${encodeURIComponent("E2B.ReadTeam()")}`).pipe(
          HttpClientRequest.setHeader(GatewayWire.TOKEN_HEADER, token),
          HttpClientRequest.bodyJsonUnsafe({ path: ["teamId"] }),
        ),
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
      );
      expect(answer).toMatch(/^[0-9a-f-]{36}$/);
      // And it refuses a call without the token.
      const refused = yield* HttpClient.execute(
        HttpClientRequest.post(`${env.gateway}/${encodeURIComponent("E2B.ReadTeam()")}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ path: ["teamId"] }),
        ),
      );
      expect(refused.status).toBe(403);
      yield* stack.destroy();
    }),
  options,
);

// Below Tier 3, sandbox egress is an allowlist that excludes Lambda and
// workers.dev urls, so the gateway answers ECONNRESET. Run with
// DAYTONA_TEST_NETWORK=1 on an account that can reach it.
test.provider.skipIf(!process.env.DAYTONA_TEST_NETWORK)(
  "a Daytona sandbox's bindings run in a Lambda Web Function gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sandbox = yield* stack.deploy(GatewayedDaytona);
      expectGatewayed(yield* get(sandbox.url!), { gatewayHost: ".on.aws" });
      yield* stack.destroy();
    }),
  options,
);
