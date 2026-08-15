/**
 * Unit coverage for the `alchemy/Nitro` adapter's request bridging
 * (pure-local, no cloud) — specifically `toWebRequest`'s THREE body
 * sources across nitro's runtimes:
 *
 *   - `event.web.request` (workerd) passes through verbatim;
 *   - a server-preset MOCK `event.node.req` (nitro's aws-lambda entry)
 *     carries the already-decoded body as a stashed property and never
 *     emits it as a stream — the adapter must read the stash, or every
 *     deployed POST reaches the effect fetch with an empty body;
 *   - a real socket-backed req streams (`Readable.toWeb`).
 *
 * Each case POSTs a distinct body to the site's echo route and asserts
 * the effect fetch saw exactly that body.
 *
 * Same process-global discipline as `Serve.test.ts`: dispatch stamps
 * `__ALCHEMY_RUNTIME__`, so tests run `{ exclusive: true }` and restore
 * the flag in `finally`.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Readable } from "node:stream";

const markers = {
  ALCHEMY_STACK_NAME: "nitro-adapter-test",
  ALCHEMY_STAGE: "test",
};

class NitroSite extends Cloudflare.Website.Vite<NitroSite>()(
  "NitroAdapterSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // Echo the request body back so tests can prove the adapter
        // delivered it intact across all three body sources.
        const body = yield* Effect.orDie(request.text);
        return HttpServerResponse.text(`echo:${body}`);
      }),
    };
  }),
) {}

/** Run `body` with the runtime flag restored afterwards (exclusive tests). */
const restoringRuntimeFlag = async (body: () => Promise<void>) => {
  const previous = globalThis.__ALCHEMY_RUNTIME__;
  try {
    await body();
  } finally {
    globalThis.__ALCHEMY_RUNTIME__ = previous;
  }
};

const echoed = async (response: Response | undefined) => {
  expect(response).toBeDefined();
  expect(response!.status).toBe(200);
  return response!.text();
};

describe("alchemy/Nitro toEventHandler", () => {
  it(
    "a server-preset mock req (stashed body, no stream) delivers the body",
    () =>
      restoringRuntimeFlag(async () => {
        const { toEventHandler } = await import("@/Serve/Nitro.ts");
        const handler = toEventHandler(NitroSite, { env: markers });

        // The nitro aws-lambda shape: a mock IncomingMessage carrying the
        // decoded event body as a property; streaming it yields nothing.
        const event = {
          path: "/api/echo",
          method: "POST",
          node: {
            req: {
              method: "POST",
              url: "/api/echo",
              headers: {
                host: "lambda.test",
                "content-type": "application/json",
              },
              body: '{"from":"stash"}',
            },
          },
        };
        expect(await echoed(await (handler as any)(event))).toBe(
          'echo:{"from":"stash"}',
        );
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "a real socket-backed req streams its body into the effect fetch",
    () =>
      restoringRuntimeFlag(async () => {
        const { toEventHandler } = await import("@/Serve/Nitro.ts");
        const handler = toEventHandler(NitroSite, { env: markers });

        const req = Readable.from([Buffer.from('{"from":"stream"}')]) as any;
        req.method = "POST";
        req.url = "/api/echo";
        req.headers = { host: "dev.test", "content-type": "application/json" };
        const event = {
          path: "/api/echo",
          method: "POST",
          node: { req },
        };
        expect(await echoed(await (handler as any)(event))).toBe(
          'echo:{"from":"stream"}',
        );
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "a workerd event's web request passes through verbatim",
    () =>
      restoringRuntimeFlag(async () => {
        const { toEventHandler } = await import("@/Serve/Nitro.ts");
        const handler = toEventHandler(NitroSite, { env: markers });

        const event = {
          web: {
            request: new Request("http://worker.test/api/echo", {
              method: "POST",
              body: '{"from":"web"}',
              headers: { "content-type": "application/json" },
            }),
          },
        };
        expect(await echoed(await (handler as any)(event))).toBe(
          'echo:{"from":"web"}',
        );
      }),
    { exclusive: true, timeout: 60_000 },
  );
});
