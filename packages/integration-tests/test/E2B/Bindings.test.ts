import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Alchemy from "alchemy";
import { Stack as StackService } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { BindingAgent, BindingBox, ProbeWebhook, RotatedSecret } from "./fixtures/resources.ts";
import E2BWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(E2B.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "E2BBindingsStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const agent = yield* BindingAgent;
    const box = yield* BindingBox;
    yield* RotatedSecret;
    yield* ProbeWebhook;
    const worker = yield* E2BWorker;
    return {
      url: worker.url.as<string>(),
      templateId: agent.templateId,
      boxId: box.sandboxId,
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:e2b", "provider:cloudflare", "provider:cloudflare:worker", "live"];

/** A stage-unique name for objects the fixture creates at runtime. */
const unique = (suffix: string) =>
  Effect.succeed(
    `alchemy-${Test.defaultStage()}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  );

// Out-of-band verification resolves E2B credentials the way the stack does:
// through the Alchemy profile, via `E2B.providers()`.
const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      E2B.providers().pipe(
        Layer.provideMerge(
          Layer.succeed(StackService, {
            name: "E2BBindingsVerify",
            stage: Test.defaultStage(),
            resources: {},
            bindings: {},
            actions: {},
          }),
        ),
        Layer.provideMerge(Layer.succeed(Stage, Test.defaultStage())),
      ),
    ),
  );

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

describe("CreateSandbox", () => {
  test(
    "reads metrics for several sandboxes in one call",
    Effect.gen(function* () {
      const body = yield* get<{ sandboxId: string; ids: string[] }>("/sandbox/metrics");
      expect(body.ids).toContain(body.sandboxId);
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "runs commands and file operations in a sandbox from the bound template",
    Effect.gen(function* () {
      const { templateId } = yield* stack;
      const body = yield* get<{
        templateId: string;
        marker: string;
        ok: { stdout: string; stderr: string; exitCode: number };
        failedExitCode: number;
        exec: string;
        fed: string;
        withEnv: string;
        timedOut: string;
        read: string;
        listed: string[];
        movedExists: boolean;
        removedExists: boolean;
        streamed: { output: string[]; stdout: string; exitCode: number };
      }>("/sandbox/commands");
      expect(body.templateId).toBe(templateId);
      expect(body.marker.trim()).toBe("bound");
      expect(body.ok).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 0 });
      expect(body.failedExitCode).toBe(3);
      expect(body.exec).toBe("argv");
      expect(body.fed).toBe("fed via stdin");
      expect(body.withEnv).toBe("hi\n");
      expect(body.timedOut).toBe("E2B.ExecTimedOut");
      expect(body.read).toBe("hello");
      expect(body.listed).toContain("a.txt");
      expect(body.movedExists).toBe(true);
      expect(body.removedExists).toBe(false);
      expect(body.streamed.output).toContain("stdout");
      expect(body.streamed.output).toContain("stderr");
      expect(body.streamed.stdout).toBe("streamed\n");
      expect(body.streamed.exitCode).toBe(0);
    }),
    { tags, timeout: 240_000 },
  );

  test(
    "finds a sandbox by metadata, pauses, resumes with its files, and kills it",
    Effect.gen(function* () {
      const task = yield* unique("lifecycle");
      const body = yield* get<{
        foundIds: string[];
        sandboxId: string;
        pausedState: string;
        notRunning: string;
        resumedState: string;
        metadata: Record<string, string>;
        state: string;
        killedAgain: string;
      }>(`/sandbox/lifecycle?task=${task}`);
      expect(body.notRunning).toBe("SandboxNotRunning");
      expect(body.foundIds).toContain(body.sandboxId);
      expect(body.pausedState).toBe("paused");
      expect(body.resumedState).toBe("running");
      expect(body.state).toBe("kept");
      expect(body.metadata.task).toBe(task);
      // Tagged with the stack, stage and the Worker that created it.
      expect(body.metadata["alchemy::stack"]).toBe("E2BBindingsStack");
      expect(body.metadata["alchemy::stage"]).toBe(Test.defaultStage());
      expect(body.metadata["alchemy::id"]).toBe("E2BWorker");
      expect(body.killedAgain).toBe("ok");
      const gone = yield* distilled(
        sandboxes.getSandbox({ sandboxID: body.sandboxId }).pipe(
          Effect.map((s): string => s.state),
          Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        ),
      );
      expect(gone).toBe("gone");
    }),
    { tags, timeout: 240_000 },
  );

  test(
    "forks a running sandbox; the fork sees the parent's files",
    Effect.gen(function* () {
      const body = yield* get<{ parent: string; fork: string; content: string }>("/sandbox/fork");
      expect(body.fork).not.toBe(body.parent);
      expect(body.content).toBe("from parent");
    }),
    { tags, timeout: 240_000 },
  );

  test(
    "snapshots a sandbox and creates a new sandbox from the snapshot",
    Effect.gen(function* () {
      const name = yield* unique("snap");
      const body = yield* get<{ snapshotId: string; listed: number; content: string }>(
        `/sandbox/snapshot?name=${name}`,
      );
      expect(body.listed).toBeGreaterThanOrEqual(1);
      expect(body.content).toBe("snapshotted");
    }),
    { tags, timeout: 300_000 },
  );
});

describe("E2BSandbox", () => {
  test(
    "drives processes, stdin, a PTY, files, logs and network on one sandbox",
    Effect.gen(function* () {
      const body = yield* get<{
        composed: string;
        statName: string;
        watched: string[];
        listedCat: boolean;
        catOut: string;
        catExitCode: number;
        reattachedOut: string;
        sleeperDetached: boolean;
        sleeperKilled: boolean;
        sleeperExitCode: number;
        ptyOut: string;
        ptyExitCode: number;
        allowOut: string[];
        logs: number;
      }>("/sandbox/handle");
      expect(body.composed).toBe("ab");
      expect(body.statName).toBe("ab.txt");
      expect(body.watched).toContain("watched.txt");
      expect(body.listedCat).toBe(true);
      expect(body.catOut).toBe("ping\n");
      expect(body.catExitCode).toBe(0);
      expect(body.reattachedOut).toBe("ping\n");
      expect(body.sleeperDetached).toBe(true);
      expect(body.sleeperKilled).toBe(true);
      expect(body.sleeperExitCode).not.toBe(0);
      expect(body.ptyOut).toContain("pty-42");
      expect(body.ptyOut).toContain("30 100");
      expect(body.ptyExitCode).toBe(0);
      expect(body.allowOut).toEqual(["github.com"]);
      expect(body.logs).toBeGreaterThan(0);
    }),
    { tags, timeout: 180_000 },
  );
});

interface Echoed {
  method: string;
  path: string;
  query: Record<string, string>;
  probe: string | null;
  body: string;
}

/** The ports sandbox, opened by the client-request test and closed by the proxy test. */
let portsSandbox: string | undefined;

describe.sequential("getTcpPort", () => {
  test(
    "getTcpPort fetch: client request",
    Effect.gen(function* () {
      const body = yield* get<{
        sandboxId: string;
        host: string;
        url: string;
        status: number;
        echoHeader: string;
        echoed: Echoed;
      }>("/ports/open");
      portsSandbox = body.sandboxId;
      expect(body.host).toBe(`8000-${body.sandboxId}.e2b.app`);
      expect(body.url).toBe(`https://${body.host}`);
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

describe.sequential("ConnectSandbox", () => {
  test(
    "connects to the declared sandbox and runs in it",
    Effect.gen(function* () {
      const { boxId } = yield* stack;
      const body = yield* get<{
        sandboxId: string;
        marker: string;
        echoed: string;
        url: string;
        host: string;
      }>("/box/run");
      expect(body.sandboxId).toBe(boxId);
      expect(body.marker.trim()).toBe("bound");
      expect(body.echoed).toBe("from the box\n");
      expect(body.host).toBe(`3000-${boxId}.e2b.app`);
      expect(body.url).toBe(`https://3000-${boxId}.e2b.app`);
      const detail = yield* distilled(sandboxes.getSandbox({ sandboxID: boxId }));
      expect(detail.metadata?.["alchemy::id"]).toBe("BindingBox");
    }),
    { tags, timeout: 180_000 },
  );

  test(
    "a paused declared sandbox fails envd calls with SandboxNotRunning until resumed",
    Effect.gen(function* () {
      yield* get("/box/run");
      const body = yield* get<{
        pausedState: string;
        whilePaused: string;
        resumedState: string;
        state: string;
      }>("/box/pause");
      expect(body.pausedState).toBe("paused");
      expect(body.whilePaused).toBe("SandboxNotRunning");
      expect(body.resumedState).toBe("running");
      expect(body.state).toBe("kept");
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateSnapshot", () => {
  test(
    "takes a warm snapshot from setup commands and boots a sandbox from it",
    Effect.gen(function* () {
      const name = yield* unique("warm");
      const body = yield* get<{ content: string }>(`/snapshots?name=${name}`);
      expect(body.content.trim()).toBe("warm");
    }),
    { tags, timeout: 300_000 },
  );
});

describe("CreateSecret", () => {
  test(
    "injects a runtime secret at egress without exposing it inside the sandbox",
    Effect.gen(function* () {
      const name = yield* unique("secret");
      const body = yield* get<{
        ref: string;
        listed: boolean;
        injected: boolean;
        leaked: boolean;
        gone: boolean;
      }>(`/secrets?name=${name}`);
      expect(body.ref).toBe(`\${e2b.secrets.${name}}`);
      expect(body.listed).toBe(true);
      expect(body.injected).toBe(true);
      expect(body.leaked).toBe(false);
      expect(body.gone).toBe(true);
    }),
    { tags, timeout: 240_000 },
  );
});

describe("WriteSecret", () => {
  test(
    "rotates a declared secret to new versions",
    Effect.gen(function* () {
      const body = yield* get<{ first: number; second: number }>("/rotate");
      expect(body.second).toBe(body.first + 1);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("CreateTemplate", () => {
  test(
    "builds a template at runtime, reuses the build, reads it and tags it",
    Effect.gen(function* () {
      const name = yield* unique("tpl");
      const body = yield* get<{
        sameBuild: boolean;
        greeting: string;
        foundBuild: boolean;
        listed: boolean;
        defaults: number;
        searched: number;
        status: string;
        logs: number;
        tagged: boolean;
        tagCount: number;
        tags: string[];
        groups: number;
        assignments: number;
        untagged: boolean;
      }>(`/templates?name=${name}`);
      expect(body.sameBuild).toBe(true);
      expect(body.greeting).toBe("built at runtime");
      expect(body.foundBuild).toBe(true);
      expect(body.listed).toBe(true);
      expect(body.defaults).toBeGreaterThan(0);
      expect(body.searched).toBeGreaterThan(0);
      expect(body.status).toBe("ready");
      expect(body.logs).toBeGreaterThan(0);
      expect(body.tagged).toBe(true);
      expect(body.tagCount).toBeGreaterThan(0);
      expect(body.tags).toContain("v1");
      expect(body.groups).toBeGreaterThan(0);
      expect(body.assignments).toBeGreaterThan(0);
      expect(body.untagged).toBe(false);
    }),
    { tags, timeout: 600_000 },
  );
});

describe("ReadTeam", () => {
  test(
    "reads the team's event log and usage metrics",
    Effect.gen(function* () {
      const body = yield* get<{
        count: number;
        sandboxEvents: number;
        teamId: string;
        metrics: number;
        peak: number;
      }>("/team");
      expect(body.count).toBeGreaterThan(0);
      expect(body.sandboxEvents).toBeGreaterThan(0);
      expect(body.teamId.length).toBeGreaterThan(0);
      expect(body.metrics).toBeGreaterThan(0);
      expect(body.peak).toBeGreaterThan(0);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadWebhook", () => {
  test(
    "reads a declared webhook's delivery history and stats",
    Effect.gen(function* () {
      const body = yield* get<{ groups: number; total: number }>("/webhook");
      // A wrong or missing webhook id fails the route with NotFound.
      expect(typeof body.groups).toBe("number");
      expect(typeof body.total).toBe("number");
    }),
    { tags, timeout: 120_000 },
  );
});
