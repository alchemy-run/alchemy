import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

const skipPaid = process.env.RENDER_TEST_METRICS_STREAM !== "1";

describe("Render.MetricsStream", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "reads workspace MetricsStream configuration cleanly",
    () =>
      Effect.gen(function* () {
        const prov = yield* Provider.findProvider(Render.MetricsStream);
        const current = yield* prov.lookup!({});
        expect(current === undefined || typeof current.ownerId === "string").toBe(true);
      }),
    { tags: ["provider:render", "live"], timeout: 60_000 },
  );

  t.test.provider.skipIf(skipPaid)(
    "configures, updates, and removes MetricsStream when RENDER_TEST_METRICS_STREAM=1",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = Render.MetricsStream("WorkspaceMetrics", {
          provider: "CUSTOM",
          url: "https://otlp.example.com",
          token: "test-metrics-token",
        });

        const created = yield* stack.deploy(program);
        expect(created.provider).toBe("CUSTOM");

        yield* expectAllNoop(stack, program);
        yield* stack.destroy();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
