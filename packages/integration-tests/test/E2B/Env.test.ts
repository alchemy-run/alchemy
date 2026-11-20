import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../EnvValues.ts";
import EnvTemplate from "./fixtures/env-program.ts";

const { test } = Test.make({ providers: E2B.providers() });

/** Boots a sandbox from the template, GETs `/` on its program's port, and kills it. */
const fetchFromSandbox = (templateId: string) =>
  Effect.acquireUseRelease(
    sandboxes.createSandbox({ templateID: templateId, timeout: 300 }),
    (sandbox) =>
      Effect.gen(function* () {
        const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
        // Sandbox traffic is private: E2B wants the sandbox's traffic token.
        const token = sandbox.trafficAccessToken;
        const res = yield* client
          .get(`https://3000-${sandbox.sandboxID}.${sandbox.domain ?? "e2b.app"}/`, {
            headers: token
              ? {
                  "e2b-traffic-access-token": Redacted.isRedacted(token)
                    ? Redacted.value(token)
                    : token,
                }
              : {},
          })
          .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
        return yield* res.json;
      }),
    (sandbox) => Effect.ignore(sandboxes.deleteSandbox({ sandboxID: sandbox.sandboxID })),
  );

test.provider(
  "a template program reads env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const template = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvTemplate;
        }),
      );
      const env = yield* fetchFromSandbox(template.templateId);
      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      expect(env).toEqual(expectedEnv);
    }),
  { tags: ["provider:e2b", "provider:e2b:template", "live"], timeout: 900_000 },
);
