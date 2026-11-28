import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

const logEndpoint = process.env.RENDER_TEST_LOG_STREAM_ENDPOINT;

describe("Render.LogStream", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "reads workspace LogStream configuration without failing",
    () =>
      Effect.gen(function* () {
        const prov = yield* Provider.findProvider(Render.LogStream);
        const current = yield* prov.lookup!({});
        expect(current === undefined || typeof current.ownerId === "string").toBe(true);
      }),
    { tags: ["provider:render", "live"], timeout: 60_000 },
  );

  t.test.provider.skipIf(!logEndpoint)(
    "configures, updates, and destroys LogStream when RENDER_TEST_LOG_STREAM_ENDPOINT is provided",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = (tokenSuffix: string) =>
          Render.LogStream("WorkspaceLogStream", {
            endpoint: logEndpoint!,
            token: Redacted.make(`test-token-${tokenSuffix}`),
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.endpoint).toBe(logEndpoint);

        yield* expectAllNoop(stack, program("v1"));

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.endpoint).toBe(logEndpoint);

        yield* stack.destroy();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
