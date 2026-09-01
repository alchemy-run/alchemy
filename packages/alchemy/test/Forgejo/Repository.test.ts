import { Repository, providers } from "@/Forgejo/index.ts";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";

interface StoredRepository {
  readonly id: number;
  owner: string;
  name: string;
  description?: string;
  website?: string;
  topics: string[];
}

/**
 * Repositories keyed by numeric ID, mirroring Forgejo: the ID is stable across
 * a rename, and `/repos/{owner}/{name}` resolves through the *current* name.
 */
const repositories = new Map<number, StoredRepository>();
let nextId = 1;

const reset = () => {
  repositories.clear();
  nextId = 1;
  server.reset();
};

const find = (owner: string, name: string) =>
  [...repositories.values()].find(
    (repository) => repository.owner === owner && repository.name === name,
  );

const payload = (repository: StoredRepository) => ({
  id: repository.id,
  name: repository.name,
  full_name: `${repository.owner}/${repository.name}`,
  html_url: `https://forge.example/${repository.owner}/${repository.name}`,
  clone_url: `https://forge.example/${repository.owner}/${repository.name}.git`,
  ssh_url: `git@forge.example:${repository.owner}/${repository.name}.git`,
  default_branch: "main",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  owner: { login: repository.owner },
  description: repository.description,
  website: repository.website,
});

const server = mockForgejo(({ method, path, body }) => {
  const fields = body as Record<string, unknown> | undefined;

  if (method === "GET" && path === "/user") return json({ login: "alice" });

  if (method === "POST" && path === "/user/repos") {
    const repository: StoredRepository = {
      id: nextId++,
      owner: "alice",
      name: String(fields?.name),
      description: fields?.description as string | undefined,
      topics: [],
    };
    repositories.set(repository.id, repository);
    return json(payload(repository), 201);
  }

  const byId = path.match(/^\/repositories\/(\d+)$/);
  if (byId !== null && method === "GET") {
    const repository = repositories.get(Number(byId[1]));
    return repository === undefined ? status(404) : json(payload(repository));
  }

  const topics = path.match(/^\/repos\/([^/]+)\/([^/]+)\/topics$/);
  if (topics !== null) {
    const repository = find(topics[1]!, topics[2]!);
    if (repository === undefined) return status(404);
    if (method === "GET") return json({ topics: repository.topics });
    if (method === "PUT") {
      repository.topics = [...(fields?.topics as string[])];
      return noContent();
    }
  }

  const single = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (single !== null) {
    const repository = find(single[1]!, single[2]!);
    if (repository === undefined) return status(404);
    if (method === "GET") return json(payload(repository));
    if (method === "PATCH") {
      if (fields?.name !== undefined) repository.name = String(fields.name);
      if (fields?.description !== undefined)
        repository.description = String(fields.description);
      // Forgejo's create endpoint takes no `website`; only the edit endpoint
      // sets it, which is what makes it a create-then-patch field here.
      if (fields?.website !== undefined)
        repository.website = String(fields.website);
      return json(payload(repository));
    }
    if (method === "DELETE") {
      repositories.delete(repository.id);
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
  "renames a repository in place, keeping its numeric ID",
  (stack) =>
    Effect.gen(function* () {
      reset();

      const created = yield* stack.deploy(
        Repository("Repo", { owner: "alice", name: "alchemy" }),
      );
      expect(created.fullName).toBe("alice/alchemy");

      const renamed = yield* stack.deploy(
        Repository("Repo", { owner: "alice", name: "forge" }),
      );

      expect(renamed.repoId).toBe(created.repoId);
      expect(renamed.fullName).toBe("alice/forge");
      expect(repositories.size).toBe(1);
      expect(repositories.get(created.repoId)?.name).toBe("forge");
    }),
);

test.provider(
  "deletes a repository that was renamed out of band, not the stale name",
  (stack) =>
    Effect.gen(function* () {
      reset();

      const created = yield* stack.deploy(
        Repository("Repo", { owner: "alice", name: "alchemy" }).pipe(destroy()),
      );

      // Stand in for a rename whose state write never landed: the live
      // repository moves while the persisted props keep the old name. Deleting
      // by that stale name would 404, which `optional` swallows as success —
      // dropping the state row and leaking the repository.
      repositories.get(created.repoId)!.name = "renamed-elsewhere";
      server.reset();

      yield* stack.destroy();

      expect(repositories.size).toBe(0);
      expect(server.find("DELETE", "/repos/alice/alchemy")).toBeUndefined();
      expect(
        server.find("DELETE", "/repos/alice/renamed-elsewhere"),
      ).toBeDefined();
    }),
);

test.provider(
  "skips the settings and topics writes on a no-op deploy",
  (stack) =>
    Effect.gen(function* () {
      reset();

      const props = {
        owner: "alice",
        name: "alchemy",
        description: "Managed by Alchemy",
        website: "https://example.com/alchemy",
        topics: ["effect", "infrastructure"],
      };

      yield* stack.deploy(Repository("Repo", props));
      expect(server.count("PATCH", "/repos/alice/alchemy")).toBe(1);
      expect(server.count("PUT", "/repos/alice/alchemy/topics")).toBe(1);

      server.reset();
      yield* stack.deploy(Repository("Repo", props));

      // Nothing changed, so neither write should be re-issued — Forgejo rejects
      // edits to an archived repository, which an unconditional PATCH would
      // turn into a permanent deploy failure.
      expect(server.count("PATCH", "/repos/alice/alchemy")).toBe(0);
      expect(server.count("PUT", "/repos/alice/alchemy/topics")).toBe(0);
    }),
);
