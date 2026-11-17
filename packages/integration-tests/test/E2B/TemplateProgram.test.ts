import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { OtelCollector, waitForWorkSpan, withCollectorUrl } from "../Utils/Telemetry.ts";
import ProgramTemplate from "./fixtures/program.ts";
import { ProbeWebhook } from "./fixtures/resources.ts";
import TracedTemplate from "./fixtures/traced.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(E2B.providers(), Cloudflare.providers()),
});

/**
 * Boots a sandbox from a template, GETs a path on its program's port, runs
 * `after` while the sandbox is still up, and kills it.
 */
const fetchFromSandbox = <A = void, E = never, R = never>(
  templateId: string,
  path: string,
  after?: Effect.Effect<A, E, R>,
) =>
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
        const text = yield* res.text;
        if (after !== undefined) yield* after;
        return text;
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

test.provider(
  "a template program exports spans to the bound OTLP destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The traced program binds the collector url at deploy, so it deploys first.
      const collector = yield* stack.deploy(OtelCollector());
      const template = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            return yield* TracedTemplate;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      // The sandbox stays up until the span arrives: the exporter batches on an interval.
      let traces = "";
      expect(
        yield* fetchFromSandbox(
          template.templateId,
          "/work?tag=e2b",
          waitForWorkSpan(collector.url!, "e2b").pipe(
            Effect.tap((json) => Effect.sync(() => void (traces = json))),
          ),
        ),
      ).toBe("did work e2b");
      expect(traces).toContain("work:e2b");
      expect(traces).toContain("e2b-template-e2e");

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:e2b",
      "provider:e2b:template",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 900_000,
  },
);
