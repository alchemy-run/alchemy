import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Git from "@distilled.cloud/github/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import GitSandbox, { owner, Repo, repository } from "./fixtures/e2b-git.ts";
import OrderSandbox from "./fixtures/e2b-order.ts";
import UnguardedSandbox from "./fixtures/e2b-unguarded.ts";
import GatewayedE2B from "./fixtures/e2b.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(E2B.providers(), Cloudflare.providers(), GitHub.providers()),
});

/** GET `path` of a sandbox of `templateId`, then delete the sandbox. */
const ask = <A>(templateId: string, path: string) =>
  Effect.acquireUseRelease(
    sandboxes.createSandbox({ templateID: templateId, timeout: 300 }),
    (sandbox) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const token = sandbox.trafficAccessToken;
        const res = yield* client
          .get(`https://3000-${sandbox.sandboxID}.${sandbox.domain ?? "e2b.app"}${path}`, {
            headers: token
              ? {
                  "e2b-traffic-access-token": Redacted.isRedacted(token)
                    ? Redacted.value(token)
                    : token,
                }
              : {},
          })
          .pipe(
            // 502 until the program's port is up.
            Effect.flatMap((res) =>
              res.status === 502 ? Effect.fail(new Error("not ready")) : Effect.succeed(res),
            ),
            Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
          );
        return res.status === 200
          ? ((yield* res.json) as unknown as A)
          : yield* Effect.fail(new Error(`${res.status}: ${yield* res.text}`));
      }),
    (sandbox) => Effect.ignore(sandboxes.deleteSandbox({ sandboxID: sandbox.sandboxID })),
  );

/** Distilled GitHub calls with the provider's credentials. */
const gh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(GitHub.providers({ baseUrl: "github.com" })));

test.provider(
  "an E2B sandbox's bindings run in its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const template = yield* stack.deploy(GatewayedE2B);
      const served = yield* ask<Served>(template.templateId, "/");
      expectGatewayed(served, { gatewayHost: "workers.dev" });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:e2b", "provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 900_000,
  },
);

test.provider(
  "git in an E2B sandbox clones and pushes through its gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const branch = `gateway-${stack.stage}`.replaceAll(/[^a-zA-Z0-9-]/g, "-");
      const ref = { owner, repo: repository, ref: `heads/${branch}` };
      yield* gh(Git.deleteRef(ref)).pipe(
        Effect.catchTag(["NotFound", "UnprocessableEntity"], () => Effect.void),
      );
      const template = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          return yield* GitSandbox;
        }),
      );

      const pushed = yield* ask<{ sha: string; remote: string; token: boolean }>(
        template.templateId,
        `/?branch=${branch}`,
      );
      // git talked to the gateway, and the sandbox held no GitHub token.
      expect(pushed.remote).toContain("workers.dev");
      expect(pushed.token).toBe(false);
      // GitHub has the commit the sandbox made.
      const head = yield* gh(Git.getRef(ref));
      expect(head.object.sha).toBe(pushed.sha);

      yield* gh(Git.deleteRef(ref));
      yield* stack.destroy();
    }),
  {
    tags: ["provider:e2b", "provider:github", "provider:cloudflare", "live"],
    timeout: 900_000,
  },
);

test.provider(
  "a binding built before its gateway still keeps its token out of the sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const template = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          return yield* OrderSandbox;
        }),
      );
      const served = yield* ask<{ listed: boolean; token: boolean }>(template.templateId, "/");
      expect(served.listed).toBe(true);
      expect(served.token).toBe(false);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:e2b", "provider:github", "provider:cloudflare", "live"],
    timeout: 900_000,
  },
);

test.provider(
  "a binding that would put a credential in a sandbox with no gateway fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Repo;
            return yield* UnguardedSandbox;
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
      expect(rendered).toContain("SecretInSandbox");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:e2b", "provider:github", "live"],
    timeout: 300_000,
  },
);
