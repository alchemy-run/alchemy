import { Webhook } from "@/Forgejo/index.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  json,
  jsonList,
  mockForgejo,
  noContent,
  status,
} from "./support/mock.ts";
import { forgejoTest } from "./support/stack.ts";

interface StoredHook {
  readonly id: number;
  config: Record<string, string>;
  events: string[];
  active: boolean;
  branch_filter: string;
}

const hooks = new Map<number, StoredHook>();
let nextId = 1;

const reset = () => {
  hooks.clear();
  nextId = 1;
  server.reset();
};

const payload = (hook: StoredHook) => ({
  id: hook.id,
  url: hook.config.url,
  updated_at: "2026-01-02T00:00:00Z",
  config: hook.config,
  events: hook.events,
  // Forgejo reports both on every hook it lists, `branch_filter` as an empty
  // string when unset — verified against 16.0.3.
  active: hook.active,
  branch_filter: hook.branch_filter,
});

const server = mockForgejo((request) => {
  const { method, path, body } = request;
  const fields = body as Record<string, unknown> | undefined;

  if (path === "/repos/acme/api/hooks") {
    if (method === "GET")
      return jsonList(request, [...hooks.values()].map(payload));
    if (method === "POST") {
      const hook: StoredHook = {
        id: nextId++,
        config: { ...(fields?.config as Record<string, string>) },
        events: [...((fields?.events as string[]) ?? [])],
        active: (fields?.active as boolean | undefined) ?? true,
        branch_filter: (fields?.branch_filter as string | undefined) ?? "",
      };
      hooks.set(hook.id, hook);
      return json(payload(hook), 201);
    }
  }

  const single = path.match(/^\/repos\/acme\/api\/hooks\/(\d+)$/);
  if (single !== null) {
    const hook = hooks.get(Number(single[1]));
    if (hook === undefined) return status(404);
    if (method === "GET") return json(payload(hook));
    if (method === "PATCH") {
      hook.config = { ...hook.config, ...(fields?.config as object) };
      hook.events = [...((fields?.events as string[]) ?? hook.events)];
      hook.active = (fields?.active as boolean | undefined) ?? hook.active;
      hook.branch_filter =
        (fields?.branch_filter as string | undefined) ?? hook.branch_filter;
      return json(payload(hook));
    }
    if (method === "DELETE") {
      hooks.delete(hook.id);
      return noContent();
    }
  }

  return undefined;
});

const { test } = forgejoTest(server);

import { adopt } from "@/AdoptPolicy.ts";
import { Repository } from "@/Forgejo/index.ts";
import { destroy } from "@/RemovalPolicy";
import { Services } from "@distilled.cloud/forgejo";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { createHmac } from "node:crypto";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { fixture, liveTest } from "./support/live.ts";

const live = liveTest();
live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: webhook rotation changes actual delivery signatures",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner, webhookUrl } = yield* fixture;
      const deliveries = yield* Ref.make<
        ReadonlyArray<{ body: string; signature: string | undefined }>
      >([]);
      const receiver = yield* BunHttpServer.make({
        hostname: "0.0.0.0",
        port: 31426,
      });
      yield* receiver.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const body = yield* request.text;
          yield* Ref.update(deliveries, (items) => [
            ...items,
            { body, signature: request.headers["x-forgejo-signature"] },
          ]);
          return HttpServerResponse.text("ok");
        }),
      );
      const repoName = "alchemy-1425-hooks";
      const deploy = (secret?: string) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: repoName,
            autoInit: true,
          }).pipe(destroy());
          return yield* Webhook("Hook", {
            owner,
            repository: repo.name,
            url: webhookUrl ?? "http://host.docker.internal:31426/hook",
            secret: secret === undefined ? undefined : Redacted.make(secret),
          });
        });
      const ping = Effect.fn(function* (id: number) {
        yield* Ref.set(deliveries, []);
        yield* Services.repository.repoTestHook({ owner, repo: repoName, id });
        const received = yield* Ref.get(deliveries).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 8,
            until: (items) => items.length > 0,
          }),
        );
        expect(received.length).toBeGreaterThan(0);
        return received[0]!;
      });
      const first = yield* stack.deploy(deploy("secret-a"));
      const deliveryA = yield* ping(first.webhookId);
      const expectedA = yield* Effect.sync(() =>
        createHmac("sha256", "secret-a").update(deliveryA.body).digest("hex"),
      );
      expect(deliveryA.signature).toBe(expectedA);
      const second = yield* stack.deploy(deploy("secret-b"));
      expect(
        (yield* Services.repository.repoListHooks({
          owner,
          repo: repoName,
        })).map((hook) => hook.id),
      ).toEqual([second.webhookId]);
      const deliveryB = yield* ping(second.webhookId);
      const expectedB = yield* Effect.sync(() =>
        createHmac("sha256", "secret-b").update(deliveryB.body).digest("hex"),
      );
      const oldSignature = yield* Effect.sync(() =>
        createHmac("sha256", "secret-a").update(deliveryB.body).digest("hex"),
      );
      const unsigned = yield* stack.deploy(deploy());
      const unsignedDelivery = yield* ping(unsigned.webhookId);
      yield* stack.destroy();
      expect(second.webhookId).not.toBe(first.webhookId);
      expect(deliveryB.signature).toBe(expectedB);
      expect(deliveryB.signature).not.toBe(oldSignature);
      expect(unsigned.webhookId).not.toBe(second.webhookId);
      expect(unsignedDelivery.signature ?? "").toBe("");
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: adopting a signing secret requires an explicit replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const repoName = "alchemy-1425-adopt-signed";
      const url = "https://example.invalid/adopt-signed";
      const program = (include: boolean, secret?: string) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: repoName,
          }).pipe(destroy());
          if (include)
            return yield* Webhook("Hook", {
              owner,
              repository: repo.name,
              url,
              active: false,
              secret: secret === undefined ? undefined : Redacted.make(secret),
            }).pipe(adopt(true));
          return undefined;
        });
      yield* stack.deploy(program(false));
      const foreign = yield* Services.repository.repoCreateHook({
        owner,
        repo: repoName,
        type: "forgejo",
        active: false,
        events: ["push"],
        config: { url, content_type: "json", secret: "foreign-secret" },
      });
      const refused = yield* stack
        .deploy(program(true, "managed-secret"))
        .pipe(Effect.result);
      yield* stack.deploy(program(true));
      const replaced = yield* stack.deploy(program(true, "managed-secret"));
      yield* stack.destroy();
      expect(JSON.stringify(refused)).toContain("UnverifiableWebhookSecret");
      expect(replaced?.webhookId).not.toBe(foreign.id);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: interrupted discovery and duplicate hooks never share identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const repoName = "alchemy-1425-duplicate-hooks";
      const url = "https://example.invalid/duplicate";
      const program = (probe: boolean) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: repoName,
          }).pipe(destroy());
          const first = yield* Webhook("First", {
            owner,
            repository: repo.name,
            url,
            active: false,
          });
          const second = yield* Webhook("Second", {
            owner,
            repository: repo.name,
            url: `${url}/second`,
            active: false,
          });
          if (probe)
            yield* Webhook("Probe", {
              owner,
              repository: repo.name,
              url,
              active: false,
            });
          return { first, second };
        });
      const created = yield* stack.deploy(program(false));
      const interrupted = yield* stack
        .deploy(program(true))
        .pipe(Effect.result);
      yield* Services.repository.repoEditHook({
        owner,
        repo: repoName,
        id: created.second.webhookId,
        config: { url },
      });
      const ambiguous = yield* stack.deploy(program(true)).pipe(Effect.result);
      const hooks = yield* Services.repository.repoListHooks({
        owner,
        repo: repoName,
      });
      yield* stack.destroy();
      expect(JSON.stringify(interrupted)).toContain("OwnedBySomeoneElse");
      expect(JSON.stringify(ambiguous)).toContain("AmbiguousWebhook");
      expect(hooks.map((h) => h.id).sort()).toEqual(
        [created.first.webhookId, created.second.webhookId].sort(),
      );
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: failed secret replacement resumes without reviving its predecessor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const repoName = "alchemy-1425-interrupted-hook";
      const program = (
        secret: string,
        url = "https://example.invalid/rotation",
      ) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: repoName,
          }).pipe(destroy());
          return yield* Webhook("Hook", {
            owner,
            repository: repo.name,
            url,
            active: false,
            secret: Redacted.make(secret),
          });
        });
      const first = yield* stack.deploy(program("before"));
      const interrupted = yield* stack
        .deploy(program("after", ""))
        .pipe(Effect.result);
      const predecessor = yield* Services.repository
        .repoGetHook({ owner, repo: repoName, id: first.webhookId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      const recovered = yield* stack.deploy(program("after"));
      const hooks = yield* Services.repository.repoListHooks({
        owner,
        repo: repoName,
      });
      yield* stack.destroy();
      expect(Result.isFailure(interrupted)).toBe(true);
      expect(predecessor).toBeUndefined();
      expect(recovered.webhookId).not.toBe(first.webhookId);
      expect(hooks.map((hook) => hook.id)).toEqual([recovered.webhookId]);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: known webhook ID miss cannot retarget a matching hook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const repoName = "alchemy-1425-hook-id-miss";
      const url = "https://example.invalid/id-miss";
      const program = (updated = false, cleanup = false) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner,
            name: repoName,
          }).pipe(destroy());
          return yield* Webhook(cleanup ? "Foreign" : "Hook", {
            owner,
            repository: repo.name,
            url,
            active: false,
            authorizationHeader: updated ? Redacted.make("updated") : undefined,
          }).pipe(adopt(cleanup));
        });
      const first = yield* stack.deploy(program());
      yield* Services.repository.repoDeleteHook({
        owner,
        repo: repoName,
        id: first.webhookId,
      });
      const foreign = yield* Services.repository.repoCreateHook({
        owner,
        repo: repoName,
        type: "forgejo",
        active: false,
        events: ["push"],
        config: { url, content_type: "json" },
      });
      const attempted = yield* stack.deploy(program(true)).pipe(Effect.result);
      const untouched = yield* Services.repository.repoGetHook({
        owner,
        repo: repoName,
        id: foreign.id,
      });
      yield* stack.deploy(program(false, true));
      yield* stack.destroy();
      expect(Result.isFailure(attempted)).toBe(true);
      expect(untouched.id).toBe(foreign.id);
    }),
  { timeout: 90_000 },
);

test.provider(
  "requires explicit adoption for an existing hook with the same delivery URL",
  (stack) =>
    Effect.gen(function* () {
      reset();

      // Stand in for a create whose state write never landed: the hook exists
      // on the instance, with exactly the config we asked for, but alchemy has
      // no record of it. Forgejo accepts several hooks pointing at one URL, so
      // creating unconditionally would add a second on every retry.
      hooks.set(1, {
        id: 1,
        config: { url: "https://deploy.example/hooks", content_type: "json" },
        events: ["push", "pull_request"],
        active: true,
        branch_filter: "",
      });
      nextId = 2;

      const resource = Webhook("Hook", {
        owner: "acme",
        repository: "api",
        url: "https://deploy.example/hooks",
        events: ["push", "pull_request"],
      });
      expect(
        Result.isFailure(yield* stack.deploy(resource).pipe(Effect.result)),
      ).toBe(true);
      const output = yield* stack.deploy(resource.pipe(adopt(true)));

      expect(output.webhookId).toBe(1);
      expect(hooks.size).toBe(1);
      expect(hooks.get(1)?.events).toEqual(["push", "pull_request"]);
      expect(server.count("POST", "/repos/acme/api/hooks")).toBe(0);
    }),
);

test.provider(
  "keeps two hooks on one URL apart when their events differ",
  (stack) =>
    Effect.gen(function* () {
      reset();

      // Same repository, same delivery URL, different events — legitimate, and
      // matching on URL alone would collapse both resources onto one hook with
      // each deploy overwriting the other's events.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Webhook("Push", {
            owner: "acme",
            repository: "api",
            url: "https://deploy.example/hooks",
            events: ["push"],
          });
          yield* Webhook("Pull", {
            owner: "acme",
            repository: "api",
            url: "https://deploy.example/hooks",
            events: ["pull_request"],
          });
        }),
      );

      expect(hooks.size).toBe(2);
      expect([...hooks.values()].map((hook) => hook.events).sort()).toEqual([
        ["pull_request"],
        ["push"],
      ]);
    }),
);

test.provider(
  "keeps two hooks on one URL and event set apart when their config differs",
  (stack) =>
    Effect.gen(function* () {
      reset();

      // Forgejo 16.0.3 accepts both of these — same repository, same URL, same
      // events, differing only in delivery config. Matching on URL and events
      // alone would hand the second resource the first one's hook, leaving one
      // live hook behind two state rows, each deploy undoing the other.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Webhook("Live", {
            owner: "acme",
            repository: "api",
            url: "https://deploy.example/hooks",
            events: ["push"],
          });
          yield* Webhook("Staged", {
            owner: "acme",
            repository: "api",
            url: "https://deploy.example/hooks",
            events: ["push"],
            active: false,
            contentType: "form",
          });
        }),
      );

      expect(hooks.size).toBe(2);
      expect([...hooks.values()].map((hook) => hook.active).sort()).toEqual([
        false,
        true,
      ]);
    }),
);

test.provider("creates, updates and deletes a webhook", (stack) =>
  Effect.gen(function* () {
    reset();

    const created = yield* stack.deploy(
      Webhook("Hook", {
        owner: "acme",
        repository: "api",
        url: "https://deploy.example/hooks",
      }),
    );
    expect(hooks.size).toBe(1);
    expect(created.url).toBe("https://deploy.example/hooks");

    const updated = yield* stack.deploy(
      Webhook("Hook", {
        owner: "acme",
        repository: "api",
        url: "https://deploy.example/hooks",
        events: ["push", "release"],
      }),
    );
    expect(updated.webhookId).toBe(created.webhookId);
    expect(hooks.size).toBe(1);
    expect(hooks.get(created.webhookId)?.events).toEqual(["push", "release"]);

    yield* stack.destroy();
    expect(hooks.size).toBe(0);
  }),
);
