import { Webhook, providers } from "@/Forgejo/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

interface StoredHook {
  readonly id: number;
  config: Record<string, string>;
  events: string[];
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
});

const server = mockForgejo(({ method, path, body }) => {
  const fields = body as Record<string, unknown> | undefined;

  if (path === "/repos/acme/api/hooks") {
    if (method === "GET") return json([...hooks.values()].map(payload));
    if (method === "POST") {
      const hook: StoredHook = {
        id: nextId++,
        config: { ...(fields?.config as Record<string, string>) },
        events: [...((fields?.events as string[]) ?? [])],
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
      return json(payload(hook));
    }
    if (method === "DELETE") {
      hooks.delete(hook.id);
      return noContent();
    }
  }

  return undefined;
});

const { test } = Test.make({
  providers: providers({
    baseUrl: "https://forge.example",
    token: "admin-token",
  }).pipe(Layer.provide(server.layer)),
});

test.provider(
  "adopts an existing hook with the same delivery URL instead of duplicating it",
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
      });
      nextId = 2;

      const output = yield* stack.deploy(
        Webhook("Hook", {
          owner: "acme",
          repository: "api",
          url: "https://deploy.example/hooks",
          events: ["push", "pull_request"],
        }),
      );

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
