import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import OpenCodeApi from "./fixtures/Api.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "OpenCodeCloudflareStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* OpenCodeApi;
    return { url: api.url.as<string>() };
  }),
);

// The first deploy builds the sandbox snapshot.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:opencode", "provider:boat", "live"];

/** Call the fixture's API; retries ride through a fresh workers.dev URL's first seconds. */
const call = (path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const request =
      body === undefined
        ? HttpClientRequest.get(`${url}${path}`)
        : HttpClientRequest.post(`${url}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* HttpClient.filterStatusOk(client)
      .execute(request)
      .pipe(
        Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
        // Say what the fixture answered: a bare status hides the cause.
        Effect.catch(() =>
          Effect.flatMap(client.execute(request), (failed) =>
            Effect.flatMap(failed.text, (text) =>
              Effect.die(new Error(`${path} returned ${failed.status}: ${text.slice(0, 2000)}`)),
            ),
          ),
        ),
      );
    return (yield* response.json) as any;
  });

type ToolUse = { readonly tool: string; readonly status: string; readonly output: string };

test(
  "OpenCode in a Boat sandbox answers with the harness's model, runs its tools, and survives a suspend",
  Effect.gen(function* () {
    const name = `oc-${Date.now()}`;
    /** Boat's listing trails a state change by a moment. */
    const stateBecomes = (wanted: string | null) =>
      call(`/${name}/state`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result: { state: string | null }) => result.state === wanted,
          times: 15,
        }),
      );
    const used = (tool: string) =>
      Effect.map(call(`/${name}/tools`), (tools: ReadonlyArray<ToolUse>) =>
        tools.filter((use) => use.tool === tool && use.status === "completed"),
      );

    yield* Effect.gen(function* () {
      // The model is the harness's Layer, and the tool a Layer in the Durable Object.
      const sum = yield* call(`/${name}/prompt`, {
        text: "What is 19 + 23? Use the alchemy_add tool, then tell me the number it returned.",
        tools: ["add"],
        requestId: "add",
      });
      // The model may fumble a call's arguments first; one that completed is the tool's answer.
      expect((yield* used("alchemy_add")).at(-1)?.output).toContain("1042");
      // The model answered after the tool: its wording is its own.
      expect(sum.text.length).toBeGreaterThan(0);

      // OpenCode's own bash runs in the sandbox.
      yield* call(`/${name}/prompt`, {
        text: "Use the bash tool to run exactly this command: printf 'opencode was here' > /home/user/hello.txt",
        tools: ["bash"],
        requestId: "write",
      });
      const wrote = (yield* used("bash")).length;
      expect(wrote).toBeGreaterThan(0);
      expect((yield* call(`/${name}/file`, { path: "/home/user/hello.txt" })).text).toBe(
        "opencode was here",
      );

      // A tool of our own reads the same sandbox through `AI.Sandbox`.
      yield* call(`/${name}/prompt`, {
        text: "Use the alchemy_count_bytes tool on /home/user/hello.txt and tell me the number.",
        tools: ["count_bytes"],
        requestId: "count",
      });
      expect((yield* used("alchemy_count_bytes")).at(-1)?.output).toContain("17");

      // Suspending stops the sandbox, and suspending it again changes nothing.
      yield* call(`/${name}/suspend`, {});
      yield* call(`/${name}/suspend`, {});
      expect((yield* stateBecomes("paused")).state).toBe("paused");

      // The next prompt resumes it: the same session, with its transcript and files.
      yield* call(`/${name}/prompt`, {
        text: "Use the bash tool to run exactly this command: cat /home/user/hello.txt",
        tools: ["bash"],
        requestId: "read",
      });
      expect((yield* stateBecomes("running")).state).toBe("running");
      // The transcript from before the suspend is still there, and bash ran again.
      expect((yield* used("alchemy_add")).length).toBeGreaterThan(0);
      const bash = yield* used("bash");
      expect(bash.length).toBeGreaterThan(wrote);
      expect(bash.at(-1)!.output).toContain("opencode was here");

      // Removing deletes it, and removing it again changes nothing.
      yield* call(`/${name}/kill`, {});
      yield* call(`/${name}/kill`, {});
      expect((yield* stateBecomes(null)).state).toBeNull();
      // A failed assertion must not leave a sandbox running.
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${name}/kill`, {}))));
  }),
  { tags, timeout: 420_000 },
);
