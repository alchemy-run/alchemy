/**
 * Unit coverage for the `alchemy/Nitro` adapter's request bridging
 * (pure-local, no cloud) — specifically `toWebRequest`'s THREE body
 * sources across nitro's runtimes:
 *
 *   - `event.web.request` (workerd) passes through verbatim;
 *   - a server-preset MOCK `event.node.req` (nitro's aws-lambda entry)
 *     carries the already-decoded body as a stashed property and never
 *     emits it as a stream — the adapter must read the stash, or every
 *     deployed rpc POST decodes an empty body into a JSON defect (500);
 *   - a real socket-backed req streams (`Readable.toWeb`).
 *
 * Same process-global discipline as `Serve.test.ts`: dispatch stamps
 * `__ALCHEMY_RUNTIME__`, so tests run `{ exclusive: true }` and restore
 * the flag in `finally`.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
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
        return HttpServerResponse.text("effect-fetch");
      }),
      bump: (n: number) => Effect.succeed(n + 1),
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

const rpcEnvelope = async (response: Response | undefined) => {
  expect(response).toBeDefined();
  expect(response!.status).toBe(200);
  return (await response!.json()) as { value?: unknown };
};

describe("alchemy/Nitro toEventHandler", () => {
  it(
    "a server-preset mock req (stashed body, no stream) dispatches rpc",
    () =>
      restoringRuntimeFlag(async () => {
        const { toEventHandler } = await import("@/Serve/Nitro.ts");
        const handler = toEventHandler(NitroSite, { env: markers });

        // The nitro aws-lambda shape: a mock IncomingMessage carrying the
        // decoded event body as a property; streaming it yields nothing.
        const event = {
          path: "/api/__rpc/bump",
          method: "POST",
          node: {
            req: {
              method: "POST",
              url: "/api/__rpc/bump",
              headers: {
                host: "lambda.test",
                "content-type": "application/json",
              },
              body: "[41]",
            },
          },
        };
        const envelope = await rpcEnvelope(await (handler as any)(event));
        expect(envelope).toEqual({ value: 42 });
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "a real socket-backed req streams its body into the dispatch",
    () =>
      restoringRuntimeFlag(async () => {
        const { toEventHandler } = await import("@/Serve/Nitro.ts");
        const handler = toEventHandler(NitroSite, { env: markers });

        const req = Readable.from([Buffer.from("[10]")]) as any;
        req.method = "POST";
        req.url = "/api/__rpc/bump";
        req.headers = { host: "dev.test", "content-type": "application/json" };
        const event = {
          path: "/api/__rpc/bump",
          method: "POST",
          node: { req },
        };
        const envelope = await rpcEnvelope(await (handler as any)(event));
        expect(envelope).toEqual({ value: 11 });
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
            request: new Request("http://worker.test/api/__rpc/bump", {
              method: "POST",
              body: "[1]",
              headers: { "content-type": "application/json" },
            }),
          },
        };
        const envelope = await rpcEnvelope(await (handler as any)(event));
        expect(envelope).toEqual({ value: 2 });
      }),
    { exclusive: true, timeout: 60_000 },
  );
});
