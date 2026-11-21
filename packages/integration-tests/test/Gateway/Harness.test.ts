import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Git from "@distilled.cloud/github/git";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { owner, Repo, repository } from "./fixtures/e2b-git.ts";
import HarnessWorker from "./fixtures/harness.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Boat.providers(), GitHub.providers()),
});

/** Distilled GitHub calls with the provider's credentials. */
const gh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(GitHub.providers({ baseUrl: "github.com" })));

type ToolUse = { readonly tool: string; readonly status: string; readonly output: string };

test.provider(
  "a harness tool pushes from the session's sandbox through the gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const branch = `harness-${stack.stage}`.replaceAll(/[^a-zA-Z0-9-]/g, "-");
      const ref = { owner, repo: repository, ref: `heads/${branch}` };
      yield* gh(Git.deleteRef(ref)).pipe(
        Effect.catchTag(["NotFound", "UnprocessableEntity"], () => Effect.void),
      );
      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          return yield* HarnessWorker;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const call = (path: string, body?: unknown) =>
        Effect.gen(function* () {
          const request =
            body === undefined
              ? HttpClientRequest.get(`${worker.url}${path}`)
              : HttpClientRequest.post(`${worker.url}${path}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe(body),
                );
          const response = yield* client.execute(request);
          if (response.status !== 200) {
            return yield* Effect.fail(
              new Error(`${path} returned ${response.status}: ${yield* response.text}`),
            );
          }
          return (yield* response.json) as any;
        });

      yield* Effect.gen(function* () {
        // A fresh workers.dev url takes a few seconds to serve.
        // Until then Cloudflare answers 404 with a page of its own.
        yield* client.get(`${worker.url}/`).pipe(
          Effect.flatMap((res) => res.text),
          Effect.flatMap((text) =>
            text === "not found" ? Effect.void : Effect.fail(new Error("not serving yet")),
          ),
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
        );
        yield* call("/push/prompt", {
          text: `Use the alchemy_push tool with the branch "${branch}", then tell me the commit it pushed.`,
        }).pipe(
          // Some of Cloudflare's edge still answers with its placeholder.
          Effect.retry({
            while: (error) => error.message.includes("There is nothing here yet"),
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
          Effect.timeout("5 minutes"),
          Effect.catch((error) =>
            Effect.flatMap(Effect.result(call("/push/tools")), (tools) =>
              Effect.fail(new Error(`${error.message}\ntools: ${JSON.stringify(tools)}`)),
            ),
          ),
        );
        const uses = (yield* call("/push/tools")) as ReadonlyArray<ToolUse>;
        const used = uses.filter((use) => use.tool === "alchemy_push");
        const pushed = JSON.parse(
          used.findLast((use) => use.status === "completed")?.output ?? "null",
        ) as {
          exitCode: number;
          sha: string;
          stderr: string;
          remote: string;
          token: boolean;
        } | null;
        if (pushed === null || pushed.exitCode !== 0) {
          // Say what the tool reported when it never completed.
          return yield* Effect.fail(
            new Error(`alchemy_push never completed: ${JSON.stringify(uses)}`),
          );
        }
        expect(pushed.stderr).not.toContain("fatal");
        expect(pushed.exitCode).toBe(0);
        // git in the sandbox was given the gateway, and no GitHub token.
        expect(pushed.remote).toContain("workers.dev");
        expect(pushed.token).toBe(false);
        // GitHub has the commit the sandbox made.
        expect((yield* gh(Git.getRef(ref))).object.sha).toBe(pushed.sha);
      }).pipe(Effect.ensuring(Effect.ignore(call("/push/kill", {}))));

      yield* gh(Git.deleteRef(ref));
      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:opencode", "provider:boat", "provider:github", "live"],
    timeout: 900_000,
  },
);
