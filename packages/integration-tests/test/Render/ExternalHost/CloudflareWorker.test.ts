import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ExternalHostWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Render.providers(), Cloudflare.providers());

const skipExternal = !process.env.CLOUDFLARE_API_TOKEN || !process.env.RENDER_API_KEY;

const { beforeAll, afterAll, deploy, destroy, test } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "RenderExternalHostStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ExternalHostWorker;
    return { url: worker.url.as<string>() };
  }),
);

describe(
  "Render bindings on an external Cloudflare Worker host",
  { tags: ["provider:render", "provider:cloudflare", "live"] },
  () => {
    const stack = beforeAll(skipExternal ? Effect.succeed({ url: "" }) : deploy(Stack), {
      timeout: 300_000,
    });
    afterAll.skipIf(skipExternal || !!process.env.NO_DESTROY)(destroy(Stack), {
      timeout: 300_000,
    });

    test.skipIf(skipExternal)(
      "ReadWriteKeyValue executes live commands from Cloudflare Worker via Render KeyValue",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* HttpClient.get(`${url}/kv`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((res) => res.json),
          Effect.map((b) => b as { ok: boolean; value?: string; error?: string }),
          Effect.flatMap((b) => (b?.ok ? Effect.succeed(b) : Effect.fail(b))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
        expect(body.ok).toBe(true);
        expect(body.value).toBe("from-cf-worker");
      }),
      { timeout: 240_000 },
    );
  },
);
