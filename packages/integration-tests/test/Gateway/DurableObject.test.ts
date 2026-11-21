import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import DurableObjectWorker from "./fixtures/durable-object.ts";
import { Repo } from "./fixtures/e2b-git.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
});

test.provider(
  "a Durable Object's binding runs in its Worker's gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          return yield* DurableObjectWorker;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const remote = (yield* client.get(worker.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 6 }),
      )) as unknown as { url: string; env: Record<string, string> };
      // The object was given the gateway, and no GitHub token.
      expect(remote.url).toContain("workers.dev");
      expect(JSON.stringify(remote)).not.toMatch(/gh[opsu]_|github_pat_|x-access-token/);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "provider:github", "live"],
    timeout: 600_000,
  },
);
