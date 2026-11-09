import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import ProgramTemplate from "./fixtures/program.ts";
import { ProbeWebhook } from "./fixtures/resources.ts";

const { test } = Test.make({ providers: E2B.providers() });

/** Boots a sandbox from a template, GETs a path on its program's port, and kills it. */
const fetchFromSandbox = (templateId: string, path: string) =>
  Effect.acquireUseRelease(
    sandboxes.createSandbox({ templateID: templateId, timeout: 300 }),
    (sandbox) =>
      Effect.gen(function* () {
        const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
        // Sandbox traffic is private: E2B wants the sandbox's traffic token.
        const token = sandbox.trafficAccessToken;
        const res = yield* client
          .get(`https://3000-${sandbox.sandboxID}.${sandbox.domain ?? "e2b.app"}${path}`, {
            headers: token
              ? {
                  "e2b-traffic-access-token": Redacted.isRedacted(token)
                    ? Redacted.value(token)
                    : token,
                }
              : {},
          })
          .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
        return yield* res.text;
      }),
    (sandbox) => Effect.ignore(sandboxes.deleteSandbox({ sandboxID: sandbox.sandboxID })),
  );

test.provider(
  "an Effect program template serves from every sandbox, with its config and bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const template = yield* stack.deploy(
        Effect.gen(function* () {
          yield* ProbeWebhook;
          return yield* ProgramTemplate;
        }),
      );
      expect(yield* fetchFromSandbox(template.templateId, "/")).toBe("hello from an E2B sandbox");
      expect(JSON.parse(yield* fetchFromSandbox(template.templateId, "/webhook"))).toEqual({
        stats: true,
      });

      // Unchanged program: no rebuild.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          yield* ProbeWebhook;
          return yield* ProgramTemplate;
        }),
      );
      expect(again.buildId).toBe(template.buildId);

      yield* stack.destroy();
    }),
  { tags: ["provider:e2b", "provider:e2b:template", "live"], timeout: 900_000 },
);

test.provider(
  "an async program template runs its main as-is with its env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const template = yield* stack.deploy(
        E2B.Template("AsyncProgram", {
          main: new URL("./fixtures/async-program.mjs", import.meta.url).pathname,
          env: { GREETING: "hi" },
        }),
      );
      expect(yield* fetchFromSandbox(template.templateId, "/")).toBe(
        "hi from an async template program",
      );
      yield* stack.destroy();
    }),
  { tags: ["provider:e2b", "provider:e2b:template", "live"], timeout: 900_000 },
);
