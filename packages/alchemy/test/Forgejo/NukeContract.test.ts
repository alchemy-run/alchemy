import {
  BranchProtection,
  Label,
  Webhook,
  providers,
} from "@/Forgejo/index.ts";
import * as Provider from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

/**
 * Account-wide teardown (`alchemy nuke`) enumerates straight from the cloud,
 * so there is no state row: `Nuke.ts` calls `delete` with the *Attributes*
 * shape passed as both `olds` and `output`. A resource whose Attributes omit
 * its parent identity therefore builds `/repos/undefined/undefined/...`,
 * 404s, and — because `optional` swallows a not-found — reports success while
 * leaving the resource behind.
 *
 * These tests drive that exact call shape.
 */

const hooks = new Map<number, { id: number; url: string }>();
const labels = new Map<number, { id: number; name: string }>();
const rules = new Map<string, { rule_name: string }>();
let nextId = 1;

const reset = () => {
  hooks.clear();
  labels.clear();
  rules.clear();
  nextId = 1;
  server.reset();
};

const server = mockForgejo(({ method, path, body }) => {
  const fields = body as Record<string, unknown> | undefined;

  if (method === "GET" && path === "/user/repos") {
    return json([{ owner: { login: "acme" }, name: "api" }]);
  }

  if (path === "/repos/acme/api/hooks") {
    if (method === "GET") {
      return json(
        [...hooks.values()].map((hook) => ({
          id: hook.id,
          url: hook.url,
          updated_at: "2026-01-02T00:00:00Z",
          config: { url: hook.url },
        })),
      );
    }
    if (method === "POST") {
      const config = fields?.config as Record<string, string>;
      const hook = { id: nextId++, url: config.url! };
      hooks.set(hook.id, hook);
      return json({
        id: hook.id,
        url: hook.url,
        updated_at: "2026-01-02T00:00:00Z",
        config,
      });
    }
  }
  const hook = path.match(/^\/repos\/acme\/api\/hooks\/(\d+)$/);
  if (hook !== null && method === "DELETE") {
    return hooks.delete(Number(hook[1])) ? noContent() : status(404);
  }

  if (path === "/repos/acme/api/labels") {
    if (method === "GET") {
      return json(
        [...labels.values()].map((label) => ({
          id: label.id,
          name: label.name,
          color: "d73a4a",
        })),
      );
    }
    if (method === "POST") {
      const label = { id: nextId++, name: String(fields?.name) };
      labels.set(label.id, label);
      return json({ id: label.id, name: label.name, color: "d73a4a" });
    }
  }
  const label = path.match(/^\/repos\/acme\/api\/labels\/(\d+)$/);
  if (label !== null) {
    const found = labels.get(Number(label[1]));
    if (method === "GET")
      return found === undefined
        ? status(404)
        : json({ id: found.id, name: found.name, color: "d73a4a" });
    if (method === "DELETE")
      return labels.delete(Number(label[1])) ? noContent() : status(404);
  }

  if (path === "/repos/acme/api/branch_protections") {
    if (method === "GET") return json([...rules.values()]);
    if (method === "POST") {
      const rule = { rule_name: String(fields?.rule_name) };
      rules.set(rule.rule_name, rule);
      return json(rule);
    }
  }
  const rule = path.match(/^\/repos\/acme\/api\/branch_protections\/(.+)$/);
  if (rule !== null) {
    const found = rules.get(rule[1]!);
    if (method === "GET")
      return found === undefined ? status(404) : json(found);
    if (method === "DELETE")
      return rules.delete(rule[1]!) ? noContent() : status(404);
  }

  return undefined;
});

const { test } = Test.make({
  providers: providers({
    baseUrl: "https://forge.example",
    token: "admin-token",
  }).pipe(Layer.provide(server.layer)),
});

/** The argument shape `Nuke.ts` builds: Attributes stand in for props. */
const nukeDelete = <A>(attributes: A) => ({
  id: "nuke",
  fqn: "nuke",
  instanceId: "",
  olds: attributes as never,
  output: attributes as never,
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
  bindings: [] as never,
  force: true,
});

test.provider("nuke can delete a webhook from its attributes alone", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Webhook("Hook", {
        owner: "acme",
        repository: "api",
        url: "https://deploy.example/hooks",
      }),
    );
    expect(hooks.size).toBe(1);

    const provider = yield* Provider.findProvider(Webhook);
    const listed = yield* provider.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.owner).toBe("acme");
    expect(listed[0]!.repository).toBe("api");

    yield* provider.delete(nukeDelete(listed[0]!));
    expect(hooks.size).toBe(0);
  }),
);

test.provider("nuke can delete a label from its attributes alone", (stack) =>
  Effect.gen(function* () {
    reset();

    yield* stack.deploy(
      Label("Bug", {
        owner: "acme",
        repository: "api",
        name: "bug",
        color: "d73a4a",
      }),
    );
    expect(labels.size).toBe(1);

    const provider = yield* Provider.findProvider(Label);
    const listed = yield* provider.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.owner).toBe("acme");
    expect(listed[0]!.repository).toBe("api");

    yield* provider.delete(nukeDelete(listed[0]!));
    expect(labels.size).toBe(0);
  }),
);

test.provider(
  "nuke can delete a branch-protection rule from its attributes alone",
  (stack) =>
    Effect.gen(function* () {
      reset();

      yield* stack.deploy(
        BranchProtection("Main", {
          owner: "acme",
          repository: "api",
          ruleName: "main",
        }),
      );
      expect(rules.size).toBe(1);

      const provider = yield* Provider.findProvider(BranchProtection);
      const listed = yield* provider.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.owner).toBe("acme");
      expect(listed[0]!.repository).toBe("api");

      yield* provider.delete(nukeDelete(listed[0]!));
      expect(rules.size).toBe(0);
    }),
);
