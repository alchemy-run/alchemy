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
import YieldedApi from "./fixtures/Api.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "YieldedAgentCloudflareStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* YieldedApi;
    return { url: api.url.as<string>() };
  }),
);

// The first deploy builds the sandbox snapshot.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:yielded-agent", "live"];

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
              Effect.die(new Error(`${path} returned ${failed.status}: ${text.slice(0, 3000)}`)),
            ),
          ),
        ),
      );
    return (yield* response.json) as any;
  });

type Message = { readonly role: string; readonly content: unknown };

test(
  "an agent calls an AI.Tool through Workers AI and its Thread remembers the run",
  Effect.gen(function* () {
    const object = `user-${Date.now()}`;
    const first = yield* call(`/${object}/math/ask`, {
      text: 'Look up the secret code for the word "teal" with the lookup_code tool, using 4 digits, then reply with the code.',
    });
    // A code the model cannot know without the tool.
    expect(first.output).toContain("CODE-TEAL-7391");
    // A Thread is known by the name it was given.
    expect(first.threadId).toBe("math");

    const second = yield* call(`/${object}/math/ask`, {
      text: "What code did the lookup tool give you before? Reply with the code only, and do not call a tool.",
    });
    expect(second.output).toContain("CODE-TEAL-7391");

    const history = (yield* call(`/${object}/math/history`)) as {
      readonly content: ReadonlyArray<Message>;
    };
    expect(history.content.filter((message) => message.role === "user")).toHaveLength(2);
    expect(JSON.stringify(history.content)).toContain("CODE-TEAL-7391");

    // Another Thread of the same Durable Object starts empty.
    const other = (yield* call(`/${object}/other/history`)) as {
      readonly content: ReadonlyArray<Message>;
    };
    expect(other.content).toHaveLength(0);
  }),
  { tags, timeout: 180_000 },
);

test(
  "a tool's declared failure reaches the model with its tag and fields",
  Effect.gen(function* () {
    const object = `user-${Date.now()}`;
    const events = (yield* call(`/${object}/bank/events`, {
      text: 'Withdraw 500 from the account "checking" with the withdraw tool, then tell me what happened.',
    })) as ReadonlyArray<{
      readonly tag: string;
      readonly tool?: string;
      readonly result?: string;
    }>;
    const failed = events.find((event) => event.tool === "withdraw");
    expect(failed?.tag).toBe("ToolCallFailed");
    // The run went on: the failure was the model's to read, not the run's end.
    expect(events.at(-1)?.tag).toBe("RunCompleted");
    const history = (yield* call(`/${object}/bank/history`)) as {
      readonly content: ReadonlyArray<Message>;
    };
    expect(JSON.stringify(history.content)).toContain("InsufficientFunds");
    expect(JSON.stringify(history.content)).toContain("137");
  }),
  { tags, timeout: 180_000 },
);

test(
  "a Thread's history outlives the instance that wrote it",
  Effect.gen(function* () {
    const object = `user-${Date.now()}`;
    yield* call(`/${object}/kept/ask`, {
      text: 'Look up the secret code for the word "plum" with the lookup_code tool, using 4 digits, then reply with the code.',
    });
    // The crash call itself fails when the instance dies under it.
    yield* call(`/${object}/kept/crash`, {}).pipe(Effect.ignore);
    const after = yield* call(`/${object}/kept/ask`, {
      text: "What code did the lookup tool give you before? Reply with the code only, and do not call a tool.",
    });
    expect(after.output).toContain("CODE-PLUM-7391");
  }),
  { tags, timeout: 180_000 },
);

test(
  "tools work in a Thread's Boat sandbox, which suspends, resumes and is removed",
  Effect.gen(function* () {
    const object = `sbx-${Date.now()}`;
    /** Boat's listing trails a state change by a moment. */
    const stateBecomes = (wanted: string | null) =>
      call(`/${object}/files/state`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result: { state: string | null }) => result.state === wanted,
          times: 15,
        }),
      );
    yield* Effect.gen(function* () {
      yield* call(`/${object}/files/file`, {
        text: 'Use the write_file tool to write the text "needle-7391" to /home/user/alpha.txt.',
      });
      expect((yield* stateBecomes("running")).state).toBe("running");

      // Suspending twice is the same as once, and the next tool call finds the file.
      yield* call(`/${object}/files/suspend`, {});
      yield* call(`/${object}/files/suspend`, {});
      expect((yield* stateBecomes("paused")).state).toBe("paused");
      const read = yield* call(`/${object}/files/file`, {
        text: "Use the read_file tool to read /home/user/alpha.txt and reply with its text.",
      });
      expect(read.output).toContain("needle-7391");

      // Removing twice is the same as once.
      yield* call(`/${object}/files/remove`, {});
      yield* call(`/${object}/files/remove`, {});
      expect((yield* stateBecomes(null)).state).toBeNull();
      // A failed assertion must not leave a sandbox running.
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${object}/files/remove`, {}))));
  }),
  { tags: [...tags, "provider:boat"], timeout: 300_000 },
);
