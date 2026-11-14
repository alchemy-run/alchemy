import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { TEST_ORG } from "./fixtures/org.ts";
import { BindingBox } from "./fixtures/resources.ts";
import BoatWorker from "./fixtures/worker.ts";

// Every binding call from the Worker sends the deployer's org.
const providers = Layer.mergeAll(Boat.providers({ org: TEST_ORG }), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "BoatBindingsStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const box = yield* BindingBox;
    const worker = yield* BoatWorker;
    return {
      url: worker.url.as<string>(),
      boxId: box.sandboxId,
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:boat", "provider:cloudflare", "provider:cloudflare:worker", "live"];

const get = <A>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    // A fresh workers.dev URL answers 404 until it propagates.
    const client = HttpClient.filterStatus(
      yield* HttpClient.HttpClient,
      (status) => status !== 404,
    );
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    const body = (yield* res.json) as A & { error?: string };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    return body;
  });

describe("BoatBindings", () => {
  test(
    "binds the deployer's org and API URL into the host next to its key",
    Effect.gen(function* () {
      const body = yield* get<{ org: string; apiBaseUrl: string }>("/boat/account");
      expect(body).toEqual({ org: TEST_ORG, apiBaseUrl: Boat.DEFAULT_API_BASE_URL });
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateSandbox", () => {
  test(
    "runs commands, background processes and file operations",
    Effect.gen(function* () {
      const body = yield* get<{
        ok: { stdout: string; stderr: string; exitCode: number };
        failedExitCode: number;
        argv: string;
        fed: string;
        withEnv: string;
        inTmp: string;
        timedOut: string;
        read: string;
        bytes: number[];
        listed: string[];
        statSize: number;
        statType: string;
        movedExists: boolean;
        removedExists: boolean;
        missing: string;
        streamed: { stdout: string; stderr: string; exitCode: number };
        killedExitCode: number;
      }>("/sandbox/commands");
      expect(body.ok).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 0 });
      expect(body.failedExitCode).toBe(3);
      expect(body.argv).toBe("it's|two words");
      expect(body.fed).toBe("fed via stdin");
      expect(body.withEnv).toBe("hi 'there'\n");
      expect(body.inTmp).toBe("/tmp\n");
      expect(body.timedOut).toBe("Boat.ExecTimedOut");
      expect(body.read).toBe("hello");
      expect(body.bytes).toEqual([0, 1, 2, 255]);
      expect(body.listed).toContain("/tmp/files/a.txt");
      expect(body.statSize).toBe(5);
      expect(body.statType).toBe("file");
      expect(body.movedExists).toBe(true);
      expect(body.removedExists).toBe(false);
      expect(body.missing).toBe("FileNotFound");
      expect(body.streamed).toEqual({
        stdout: "line1\nline2\nline3\n",
        stderr: "oops\n",
        exitCode: 4,
      });
      expect(body.killedExitCode).not.toBe(0);
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "labels sandboxes with the host, finds them by label, stops, forks and resumes them",
    Effect.gen(function* () {
      const task = `lifecycle-${Test.defaultStage()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const body = yield* get<{
        sandboxId: string;
        labels: Record<string, string>;
        forkLabels: Record<string, string>;
        foundIds: string[];
        stoppedState: string;
        notRunning: string;
        forkNote: string;
        resumed: string;
      }>(`/sandbox/lifecycle?task=${task}`);
      const owner = {
        "alchemy.stack": "BoatBindingsStack",
        "alchemy.stage": Test.defaultStage(),
        "alchemy.id": "BoatWorker",
      };
      expect(body.labels).toEqual({ ...owner, task });
      expect(body.forkLabels).toEqual(owner);
      expect(body.foundIds).toContain(body.sandboxId);
      expect(body.stoppedState).toBe("archived");
      expect(body.notRunning).toBe("SandboxNotRunning");
      expect(body.forkNote).toBe("from parent");
      expect(body.resumed).toBe("from parent");
      // The route deleted both when it ended.
      const gone = yield* boat.getSandbox({ sandboxId: body.sandboxId }).pipe(
        Effect.map((got): string => got.sandbox?.state ?? "gone"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        // Out-of-band verification resolves credentials as the stack does.
        Effect.provide(
          Layer.mergeAll(Boat.BoatAuth, Boat.fromAuthProvider(), FetchHttpClient.layer),
        ),
      );
      expect(gone).toBe("gone");
    }),
    { tags, timeout: 240_000 },
  );
});

describe("ConnectSandbox", () => {
  test(
    "runs commands and file operations in the declared sandbox",
    Effect.gen(function* () {
      const { boxId } = yield* stack;
      const body = yield* get<{ sandboxId: string; stdout: string; state: string }>("/box");
      expect(body.sandboxId).toBe(boxId);
      expect(body.stdout.startsWith("1")).toBe(true);
    }),
    { tags, timeout: 120_000 },
  );
});

interface Echoed {
  method: string;
  path: string;
  query: Record<string, string>;
  probe: string | null;
  body: string;
}

/** The ports sandbox, opened by the client-request test and deleted by the proxy test. */
let portsSandbox: string | undefined;

describe.sequential("getTcpPort", () => {
  test(
    "getTcpPort fetch: client request",
    Effect.gen(function* () {
      const body = yield* get<{
        sandboxId: string;
        url: string;
        protected: boolean;
        status: number;
        echoHeader: string;
        echoed: Echoed;
      }>("/ports/open");
      portsSandbox = body.sandboxId;
      expect(body.url).toMatch(/^https:\/\/[a-z0-9-]+-8000\.on\.boat\.dev$/);
      expect(body.protected).toBe(true);
      expect(body.status).toBe(201);
      expect(body.echoHeader).toBe("sandbox");
      expect(body.echoed).toEqual({
        method: "POST",
        path: "/echo/client",
        query: { a: "1", b: "two" },
        probe: "client",
        body: "client body",
      });
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "getTcpPort fetch: proxies a server request",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const sandboxId =
        portsSandbox ?? (yield* get<{ sandboxId: string }>("/ports/open")).sandboxId;
      portsSandbox = sandboxId;
      const client = HttpClient.filterStatus(
        yield* HttpClient.HttpClient,
        (status) => status !== 404,
      );
      const res = yield* client
        .execute(
          HttpClientRequest.post(`${url}/proxy/echo/server?a=1&b=two`).pipe(
            HttpClientRequest.setHeaders({ "x-probe": "proxied", "x-sandbox-id": sandboxId }),
            HttpClientRequest.bodyText("proxied body", "text/plain"),
          ),
        )
        .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
      // Compared first, so a fixture error shows its message.
      expect(yield* res.json).toEqual({
        method: "POST",
        path: "/proxy/echo/server",
        query: { a: "1", b: "two" },
        probe: "proxied",
        body: "proxied body",
      });
      expect(res.status).toBe(201);
      expect(res.headers["x-echo"]).toBe("sandbox");
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          const sandboxId = portsSandbox;
          portsSandbox = undefined;
          return sandboxId === undefined
            ? Effect.void
            : get(`/ports/close?sandbox=${sandboxId}`).pipe(Effect.ignore);
        }),
      ),
    ),
    { tags, timeout: 180_000 },
  );
});
