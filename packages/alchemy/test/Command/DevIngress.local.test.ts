import * as Command from "@/Command/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";

/**
 * A `Command.Dev` server is put on the shared `alchemy dev` ingress like a
 * Worker: `<name>.<domain>` routes to it. The Command sidecar hosts the dev
 * server, the Cloudflare sidecar hosts the ingress — the route travels over
 * RPC between them (see `Local/DevIngressClient.ts`), which is exactly the
 * multi-sidecar topology a real `alchemy dev` run has.
 */
const PORT = 13375;

const { test } = Test.make({
  providers: Command.providers(),
  dev: true,
  ingress: { domain: "localhost", port: PORT },
});

const httpServerScript = pathe.join(
  pathe.resolve(import.meta.dirname, "fixture"),
  "http-server.cjs",
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

const viaIngress = (host: string, path: string, accept = "application/json") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(
      `http://127.0.0.1:${PORT}${path}`,
    ).pipe(HttpClientRequest.setHeaders({ host: `${host}:${PORT}`, accept }));
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        res.status < 500
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new NotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: Schedule.max([
          Schedule.spaced("500 millis"),
          Schedule.recurs(20),
        ]),
      }),
    );
  }).pipe(Effect.orDie);

test.provider(
  "a Command.Dev server is served on <name>.localhost through the ingress",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const web = yield* Command.Dev("Web", {
            command: `node ${httpServerScript}`,
            env: { PORT: "0" },
          });
          const api = yield* Command.Dev("Api", {
            command: `node ${httpServerScript}`,
            env: { PORT: "0" },
          });
          return { web, api };
        }),
      );
      // `url` stays the server's own address — Docker-hosted emulators dial
      // it directly and cannot resolve `*.localhost` names.
      expect(output.web.url).toMatch(/^http:\/\/localhost:\d+\/$/);
      expect(output.api.url).toMatch(/^http:\/\/localhost:\d+\/$/);
      expect(output.api.url).not.toBe(output.web.url);

      // Each subdomain lands on its own server.
      const apiRes = yield* viaIngress("api.localhost", "/");
      const apiBody = (yield* apiRes.json) as unknown as { host: string };
      expect(`http://${apiBody.host}/`).toBe(output.api.url);

      const res = yield* viaIngress("web.localhost", "/hello?x=1");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as unknown as {
        path: string;
        forwardedHost: string | null;
        forwardedProto: string | null;
      };
      expect(body.path).toBe("/hello?x=1");
      expect(body.forwardedHost).toBe(`web.localhost:${PORT}`);
      expect(body.forwardedProto).toBe("http");

      // Both listed on the index with their type.
      const index = yield* viaIngress("localhost", "/", "text/html");
      const html = yield* index.text;
      expect(html).toContain(`http://web.localhost:${PORT}`);
      expect(html).toContain(`http://api.localhost:${PORT}`);
      expect(html).toContain("Command.Dev");

      yield* stack.destroy();

      const gone = yield* viaIngress("web.localhost", "/");
      expect(gone.status).toBe(404);
    }),
  { timeout: 120_000 },
);
