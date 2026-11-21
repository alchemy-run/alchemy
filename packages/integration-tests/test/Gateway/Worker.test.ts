import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Git from "@distilled.cloud/github/git";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import DelegatingWorker from "./fixtures/delegating-worker.ts";
import { owner, Repo, repository } from "./fixtures/e2b-git.ts";
import GatewayedWorker from "./fixtures/worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), E2B.providers(), GitHub.providers()),
});

test.provider(
  "a Worker's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(GatewayedWorker);

      const client = yield* HttpClient.HttpClient;
      const served = yield* client.get(worker.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        // A fresh workers.dev url takes a few seconds to serve.
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
      );
      expectGatewayed(served as unknown as Served, { gatewayHost: "workers.dev" });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "provider:e2b", "live"],
    timeout: 600_000,
  },
);

/** Distilled GitHub calls with the provider's credentials. */
const gh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(GitHub.providers({ baseUrl: "github.com" })));

test.provider(
  "a Worker hands a sandbox it creates a git remote on its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const branch = `delegated-${stack.stage}`.replaceAll(/[^a-zA-Z0-9-]/g, "-");
      const ref = { owner, repo: repository, ref: `heads/${branch}` };
      yield* gh(Git.deleteRef(ref)).pipe(
        Effect.catchTag(["NotFound", "UnprocessableEntity"], () => Effect.void),
      );
      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          return yield* DelegatingWorker;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const pushed = (yield* client.get(`${worker.url}?branch=${branch}`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
      )) as unknown as {
        exitCode: number;
        stderr: string;
        sha: string;
        remote: string;
        token: boolean;
      };
      // git's own progress goes to stderr; a failure names itself there.
      expect(pushed.stderr).not.toContain("fatal");
      expect(pushed.exitCode).toBe(0);
      // The sandbox was given the gateway, and no GitHub token.
      expect(pushed.remote).toContain("workers.dev");
      expect(pushed.token).toBe(false);
      // GitHub has the commit the sandbox made.
      expect((yield* gh(Git.getRef(ref))).object.sha).toBe(pushed.sha);

      yield* gh(Git.deleteRef(ref));
      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:e2b", "provider:github", "live"],
    timeout: 900_000,
  },
);
