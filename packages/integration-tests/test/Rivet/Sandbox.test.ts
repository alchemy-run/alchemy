import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { SANDBOX_FRONT_PORT } from "./fixtures/sandbox-cluster.ts";
import SandboxFront from "./fixtures/sandbox-front.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const stack = Core.scratchStack(testOptions, "RivetSandbox", import.meta.url);

const url = `http://localhost:${SANDBOX_FRONT_PORT}`;

/** GET a front route as JSON; a 500 carries the failure's cause. */
const get = <T>(path: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return (yield* client.get(`${url}${path}`).pipe(Effect.flatMap((res) => res.json))) as T;
  });

type ExecResult = { exitCode: number; stdout: string; stderr: string };

// agentOS VMs on the prebuilt actor Rivet Services runs, on a local Docker
// control plane, driven from a Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Rivet.CreateSandbox",
  { tags: ["provider:rivet", "provider:rivet:sandbox", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* SandboxFront;
            return { front: front.name };
          }),
        );
        expect(outputs.front).toBeTruthy();
        // The Services nodes take a while to start: wait until a VM answers.
        yield* get<ExecResult>(`/exec/probe-${crypto.randomUUID().slice(0, 8)}?command=true`).pipe(
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 60 }),
        );
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    const key = () => `vm-${crypto.randomUUID().slice(0, 8)}`;

    test(
      "exec returns a command's output, and a non-zero exit without failing",
      Effect.gen(function* () {
        const vm = key();
        const ok = yield* get<ExecResult>(`/exec/${vm}?command=${encodeURIComponent("echo hi")}`);
        expect(ok).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
        const failed = yield* get<ExecResult>(
          `/exec/${vm}?command=${encodeURIComponent("echo nope >&2; exit 3")}`,
        );
        expect(failed).toEqual({ exitCode: 3, stdout: "", stderr: "nope\n" });
      }),
      { timeout: 120_000 },
    );

    test(
      "a VM starts with the template's environment and software",
      Effect.gen(function* () {
        const vm = key();
        expect((yield* get<ExecResult>(`/env/${vm}`)).stdout).toBe("hello from the template\n");
        expect(yield* get<ExecResult>(`/jq/${vm}`)).toMatchObject({ exitCode: 0, stdout: "42\n" });
      }),
      { timeout: 120_000 },
    );

    test(
      "files written to a VM are read back, listed and removed, and the VM keeps them between calls",
      Effect.gen(function* () {
        const vm = key();
        yield* get(`/write/${vm}?text=kept`);
        const read = yield* get<{
          text: string;
          list: ReadonlyArray<{ path: string; type: string }>;
          stat: { path: string; type: string; size?: number };
        }>(`/read/${vm}`);
        expect(read.text).toBe("kept");
        expect(read.list).toEqual([{ path: "/home/agentos/notes/a.txt", type: "file" }]);
        expect(read.stat).toEqual({ path: "/home/agentos/notes/a.txt", type: "file", size: 4 });
        expect(yield* get<{ exists: boolean }>(`/remove/${vm}`)).toEqual({ exists: false });
      }),
      { timeout: 120_000 },
    );

    test(
      "a started process streams stdout and stderr, then reports its exit",
      Effect.gen(function* () {
        expect(yield* get(`/stream/${key()}`)).toEqual({
          exitCode: 0,
          stdout: "one\nthree\n",
          stderr: "two\n",
        });
      }),
      { timeout: 120_000 },
    );

    test(
      "a server in the VM is reached through its port",
      Effect.gen(function* () {
        expect(yield* get(`/port/${key()}`)).toEqual({ status: 200, text: "pong /ping" });
      }),
      { timeout: 120_000 },
    );

    test(
      "destroy removes the VM, and its key starts an empty one",
      Effect.gen(function* () {
        const vm = key();
        yield* get(`/write/${vm}?text=gone`);
        yield* get(`/destroy/${vm}`);
        const after = yield* get<ExecResult>(
          `/exec/${vm}?command=${encodeURIComponent("test -e /home/agentos/notes/a.txt")}`,
        ).pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }));
        expect(after.exitCode).not.toBe(0);
      }),
      { timeout: 120_000 },
    );
  },
);
