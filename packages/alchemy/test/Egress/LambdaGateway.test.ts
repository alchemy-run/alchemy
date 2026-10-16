import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type Granted, MINT_INVOKE } from "@/Egress/Gateway.ts";
import { makeLocalCa } from "@/Egress/LocalCa.ts";
import { serveEgressProxy, writeTrustBundle } from "@/Egress/Proxy.ts";
import * as Test from "@/Test/Alchemy";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { READ_REPO } from "./fixtures/lambda-gateway/gateway.ts";
import LambdaGatewayStack, { providers, state } from "./fixtures/lambda-gateway/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });
const stack = beforeAll(deploy(LambdaGatewayStack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(LambdaGatewayStack), { timeout: 300_000 });

const options = {
  tags: ["live", "provider:aws", "provider:github", "provider:cloudflare"],
  timeout: 180_000,
};

/** A grant (and route table) minted by the consumer Worker with `lambda:InvokeFunction`. */
const mintGrant = (ttl?: number) =>
  Effect.gen(function* () {
    const { consumer } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const url = new URL("/grant", consumer);
    if (ttl !== undefined) url.searchParams.set("ttl", String(ttl));
    return yield* client.get(url).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json
          : Effect.flatMap(response.text, (body) =>
              Effect.fail(new Error(`${response.status}: ${body}`)),
            ),
      ),
      Effect.map((body) => body as unknown as Granted),
      // A fresh role's trust policy and invoke permission take a few seconds to propagate.
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 8 }),
    );
  });

/** A request to the gateway's function URL, the way the egress proxy sends one. */
const viaGateway = (granted: Granted, target: string, grant = granted.routes[0]!.grant) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(granted.routes[0]!.gateway.url).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Macaroon ${grant}`,
          "x-alchemy-target": target,
          "x-alchemy-method": "GET",
          "user-agent": "alchemy-egress-test",
        }),
      ),
    );
    return { status: response.status, headers: response.headers, body: yield* response.text };
  });

describe("Egress.Gateway on AWS Lambda", () => {
  test(
    "the consumer mints over InvokeFunction; routes point at the function URL",
    Effect.gen(function* () {
      const { consumer, gateway } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const transport = (yield* client.get(new URL("/transport", consumer)).pipe(
        Effect.flatMap((response) => response.json),
        Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 10 }),
      )) as { transport: string; url: string };
      expect(transport.transport).toBe("lambda");
      expect(transport.url).toBe(new URL("/", gateway).toString());

      const granted = yield* mintGrant();
      expect(Object.keys(granted.minted)).toEqual(["EgressLambdaTestGateway"]);
      expect(granted.routes.map(({ host, paths }) => ({ host, paths }))).toEqual([
        { host: "github.com", paths: [`/${READ_REPO}/**`, `/${READ_REPO}.git/**`] },
        { host: "api.github.com", paths: [`/repos/${READ_REPO}/**`] },
        { host: "uploads.github.com", paths: [`/repos/${READ_REPO}/**`] },
      ]);
      expect(granted.routes[0]!.gateway.url).toBe(new URL("/", gateway).toString());
    }),
    options,
  );

  test(
    "the Lambda gateway refuses to mint for a repository it isn't configured for",
    Effect.gen(function* () {
      const { consumer } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const body = (yield* client.get(new URL("/refused", consumer)).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((body) => body as { error: string | null; message?: string }),
        Effect.repeat({
          schedule: Schedule.exponential("1 second"),
          until: (body) => body.error === "EgressNotServed",
          times: 8,
        }),
      )) as { error: string; message: string };
      expect(body.error).toBe("EgressNotServed");
      expect(body.message).toContain("cli/cli");
    }),
    options,
  );

  test(
    "an allowed read gets the real token; a path outside the grant is 403",
    Effect.gen(function* () {
      const granted = yield* mintGrant();
      const read = yield* viaGateway(granted, `https://api.github.com/repos/${READ_REPO}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => r.status === 200,
          times: 10,
        }),
      );
      expect(read.status, read.body).toBe(200);
      expect((JSON.parse(read.body) as { full_name: string }).full_name).toBe(READ_REPO);
      // Authenticated: GitHub's limit for a token, not the anonymous 60.
      expect(Number(read.headers["x-ratelimit-limit"])).toBeGreaterThan(60);

      const outside = yield* viaGateway(granted, "https://api.github.com/repos/cli/cli");
      expect(outside.status, outside.body).toBe(403);
      expect(outside.body).toContain("is not granted");

      const tampered = yield* viaGateway(
        granted,
        `https://api.github.com/repos/${READ_REPO}`,
        "garbage",
      );
      expect(tampered.status).toBe(401);
    }),
    options,
  );

  test(
    "mint is not reachable over the public function URL",
    Effect.gen(function* () {
      const { gateway } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const refs = [{ gateway: "EgressLambdaTestGateway", egress: "repo" }];
      const attempts = [
        // The direct-invoke event, POSTed as the body.
        HttpClientRequest.post(gateway).pipe(
          HttpClientRequest.bodyJsonUnsafe({ [MINT_INVOKE]: { refs, ttl: 60_000 } }),
        ),
        // The HTTP RPC route other hosts expose shape methods on.
        HttpClientRequest.post(new URL("/__rpc__/mint", gateway).toString()).pipe(
          HttpClientRequest.bodyJsonUnsafe([refs, 60_000]),
        ),
        HttpClientRequest.get(new URL("/mint", gateway).toString()),
      ];
      for (const attempt of attempts) {
        const response = yield* client.execute(attempt).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (r) => r.status !== 502 && r.status !== 503,
            times: 5,
          }),
        );
        const body = yield* response.text;
        expect(response.status, body).toBe(401);
        expect(body).not.toContain('grant":');
        expect(body).toContain("no valid grant");
      }
    }),
    options,
  );

  test(
    "the egress proxy sends api.github.com through the Lambda gateway",
    Effect.gen(function* () {
      const granted = yield* mintGrant();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ca = yield* makeLocalCa;
      const routes = yield* SubscriptionRef.make(granted.routes);
      const proxy = yield* serveEgressProxy({ port: 0, routes, ca });
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-egress-lambda-" });
      const bundle = path.join(dir, "bundle.pem");
      yield* writeTrustBundle(bundle, [ca.pem]);

      const curl = (url: string, headers: ReadonlyArray<string> = []) =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(
              "curl",
              [
                "-sS",
                "--max-time",
                "30",
                "--proxy",
                proxy.url,
                "--cacert",
                bundle,
                ...headers.flatMap((header) => ["-H", header]),
                "-w",
                "\n%{http_code}",
                url,
              ],
              { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
            ),
          );
          const [stdout, stderr] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText, Stream.mkString),
              child.stderr.pipe(Stream.decodeText, Stream.mkString),
            ],
            { concurrency: "unbounded" },
          );
          const lines = stdout.trimEnd().split("\n");
          return { status: Number(lines.pop()), body: lines.join("\n"), stderr };
        }).pipe(Effect.scoped);

      // `gh` sends its placeholder token; the gateway replaces it.
      const read = yield* curl(`https://api.github.com/repos/${READ_REPO}`, [
        "Authorization: token alchemy-egress",
      ]).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => r.status === 200,
          times: 5,
        }),
      );
      expect(read.status, `${read.body}\n${read.stderr}`).toBe(200);
      expect((JSON.parse(read.body) as { full_name: string }).full_name).toBe(READ_REPO);

      // Outside the routes: straight out, with no credential added.
      const direct = yield* curl("https://api.github.com/zen");
      expect(direct.status, direct.body).toBe(200);
      expect(direct.body.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    options,
  );
});
