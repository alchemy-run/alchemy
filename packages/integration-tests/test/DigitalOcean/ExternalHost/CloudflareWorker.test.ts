import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DigitalOcean from "@alchemy.run/digitalocean";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/digitalocean";
import * as Alchemy from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import ExternalHostWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(DigitalOcean.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "DigitalOceanExternalHostStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    // Insights takes a token the caller passes: the testing profile's.
    const { apiKey } = yield* yield* Credentials;
    const ambient = yield* ConfigProvider.ConfigProvider;
    const worker = yield* ExternalHostWorker.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ DO_TEST_KEY: Redacted.value(apiKey) }),
          ambient,
        ),
      ),
    );
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

type Body = { ok: boolean; result?: any; error?: string };

// A fresh workers.dev URL and a just-minted Spaces key take a moment to
// work: retry until the route answers `ok`, then report the last answer.
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("20 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe(
  "DigitalOcean bindings on a Cloudflare Worker",
  { tags: ["provider:digitalocean", "provider:cloudflare", "live"] },
  () => {
    test(
      "Spaces PutObject and GetObject with the Worker's scoped key",
      Effect.gen(function* () {
        const body = yield* call("/spaces");
        expectOk(body);
        expect(body.result.text).toBe("from-worker");
      }),
      { timeout: 240_000 },
    );

    test(
      "Security ReadSecret",
      Effect.gen(function* () {
        const body = yield* call("/secret");
        expectOk(body);
        expect(body.result.text).toBe("hello from digitalocean");
      }),
      { timeout: 240_000 },
    );

    test(
      "Functions InvokeFunction with the Worker's access key",
      Effect.gen(function* () {
        const body = yield* call("/function");
        expectOk(body);
        expect(body.result).toEqual({ sum: 42 });
      }),
      { timeout: 240_000 },
    );

    test(
      "Inference CreateResponse and CreateMessage",
      Effect.gen(function* () {
        const responses = yield* call("/responses");
        expectOk(responses);
        expect(responses.result.outputs).toBeGreaterThan(0);
        const messages = yield* call("/messages");
        expectOk(messages);
        expect(messages.result.blocks).toBeGreaterThan(0);
      }),
      { timeout: 240_000 },
    );

    test(
      "Insights QueryMetrics and SearchLogs with the token the caller passed",
      Effect.gen(function* () {
        const body = yield* call("/insights");
        expectOk(body);
        expect(body.result.metrics.status).toBe("success");
        expect(body.result.logs).toHaveProperty("pagination");
      }),
      { timeout: 240_000 },
    );
  },
);
