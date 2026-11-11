import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DigitalOcean from "@alchemy.run/digitalocean";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
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
    const worker = yield* ExternalHostWorker;
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
  },
);
