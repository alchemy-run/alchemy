import { Repository } from "@/Forgejo/index.ts";
import { destroy } from "@/RemovalPolicy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { json, mockForgejo, noContent, status } from "./support/mock.ts";
import { forgejoTest } from "./support/stack.ts";

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

const { test } = forgejoTest(server);

import { adopt } from "@/AdoptPolicy.ts";
import { Organization } from "@/Forgejo/index.ts";
import { Services } from "@distilled.cloud/forgejo";
import * as Result from "effect/Result";
import { fixture, liveTest, liveProviders } from "./support/live.ts";
import * as Provider from "@/Provider.ts";
import { scratchStack } from "@/Test/Core.ts";

import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
const live = liveTest();
const racing = liveTest((client) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "POST" && request.url.endsWith("/user/repos")) {
        yield* client.execute(
          request.pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: "alchemy-1425-repo-race",
              description: "race winner",
            }),
          ),
        );
      }
      return yield* client.execute(request);
    }),
  ),
);

racing.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: repository create conflict cannot bypass adoption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const name = "alchemy-1425-repo-race";
      const resource = Repository("Repo", {
        owner,
        name,
        description: "managed",
      }).pipe(destroy());
      const refused = yield* stack.deploy(resource).pipe(Effect.result);
      const before = yield* Services.repository.getRepo({ owner, repo: name });
      yield* stack.deploy(resource.pipe(adopt(true)));
      const after = yield* Services.repository.getRepo({ owner, repo: name });
      yield* stack.destroy();
      expect(JSON.stringify(refused)).toContain("OwnedBySomeoneElse");
      expect(before.description).toBe("race winner");
      expect(after.description).toBe("managed");
    }),
  { timeout: 90_000 },
);
live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: foreign repository requires explicit adoption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const name = "alchemy-1425-foreign";
      const foreign = yield* Services.repository.createCurrentUserRepo({
        name,
        description: "foreign",
      });
      const resource = Repository("Foreign", {
        owner,
        name,
        description: "managed",
      }).pipe(destroy());
      const refused = yield* stack.deploy(resource).pipe(Effect.result);
      const untouched = yield* Services.repository.getRepo({
        owner,
        repo: name,
      });
      const adopted = yield* stack.deploy(resource.pipe(adopt(true)));
      yield* stack.destroy();
      expect(Result.isFailure(refused)).toBe(true);
      expect(untouched.description).toBe("foreign");
      expect(adopted.repoId).toBe(foreign.id);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: missing repository ID never deletes a reused name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const name = "alchemy-1425-reused";
      yield* stack.deploy(Repository("Repo", { owner, name }).pipe(destroy()));
      yield* Services.repository.deleteRepo({ owner, repo: name });
      const successor = yield* Services.repository.createCurrentUserRepo({
        name,
      });
      yield* stack.destroy();
      const preserved = yield* Services.repository
        .getRepo({ owner, repo: name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      yield* stack.deploy(
        Repository("Successor", { owner, name }).pipe(destroy(), adopt(true)),
      );
      yield* stack.destroy();
      expect(preserved?.id).toBe(successor.id);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: transferred repository stays the same physical generation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const name = "alchemy-1425-transfer";
      const orgName = "alchemy-1425-transfer-org";
      const deploy = (repoOwner: string) =>
        Effect.gen(function* () {
          yield* Organization("Org", { owner, username: orgName }).pipe(
            destroy(),
          );
          return yield* Repository("Repo", { owner: repoOwner, name }).pipe(
            destroy(),
          );
        });
      const first = yield* stack.deploy(deploy(owner));
      yield* Services.repository.transferRepo({
        owner,
        repo: name,
        new_owner: orgName,
      });
      const next = yield* stack.deploy(deploy(orgName));
      const observed = yield* Services.repository
        .repoGetByID({ id: first.repoId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      yield* stack.destroy();
      expect(next.repoId).toBe(first.repoId);
      expect(observed?.owner.login).toBe(orgName);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: a second stage cannot claim the first stage's repository",
  (stack) =>
    Effect.gen(function* () {
      const other = scratchStack(
        { providers: liveProviders, stage: "forgejo-1425-other" },
        stack.name,
      );
      yield* stack.destroy();
      yield* other.destroy();
      const { username: owner } = yield* fixture;
      const name = "alchemy-1425-stage-isolation";
      const first = yield* stack.deploy(
        Repository("Repo", { owner, name, description: "first stage" }).pipe(
          destroy(),
        ),
      );
      const refused = yield* other
        .deploy(
          Repository("Repo", { owner, name, description: "other stage" }).pipe(
            destroy(),
          ),
        )
        .pipe(Effect.result);
      const live = yield* Services.repository.getRepo({ owner, repo: name });
      yield* other.destroy();
      yield* stack.destroy();
      expect(JSON.stringify(refused)).toContain("OwnedBySomeoneElse");
      expect(live.id).toBe(first.repoId);
      expect(live.description).toBe("first stage");
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: repository attribute-only deletion is idempotent after rename and disappearance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner, baseUrl } = yield* fixture;
      const attrs = yield* stack.deploy(
        Repository("Repo", { owner, name: "alchemy-1425-attrs" }).pipe(
          destroy(),
        ),
      );
      expect(attrs.owner).toBe(owner);
      expect(attrs.name).toBe("alchemy-1425-attrs");
      expect(attrs.apiBaseUrl).toBe(`${baseUrl}/api/v1`);
      yield* Services.repository.editRepo({
        owner,
        repo: attrs.name,
        name: "alchemy-1425-attrs-renamed",
      });
      const provider = yield* Provider.findProvider(Repository);
      const input = {
        id: "Repo",
        fqn: "Repo",
        instanceId: "",
        olds: attrs,
        output: attrs,
        bindings: [],
        session: {
          emit: () => Effect.void,
          done: () => Effect.void,
          note: () => Effect.void,
        },
      };
      yield* provider.delete(input);
      yield* provider.delete(input);
      yield* stack.destroy();
      expect(
        yield* Services.repository
          .repoGetByID({ id: attrs.repoId })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      ).toBeUndefined();
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: genuine owner replacement creates a distinct repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const orgName = "alchemy-1425-owner-replacement";
      const name = "alchemy-1425-owner-replacement";
      const program = (move: boolean) =>
        Effect.gen(function* () {
          const org = yield* Organization("Org", {
            owner,
            username: orgName,
          }).pipe(destroy());
          return yield* Repository("Repo", {
            owner: move ? org.username : owner,
            name,
          }).pipe(destroy());
        });
      const first = yield* stack.deploy(program(false));
      const second = yield* stack.deploy(program(true));
      expect(second.repoId).not.toBe(first.repoId);
      expect(second.owner).toBe(orgName);
      expect(
        yield* Services.repository
          .repoGetByID({ id: first.repoId })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      ).toBeUndefined();
      yield* stack.destroy();
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: owner replacement refuses a foreign target and preserves its predecessor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username: owner } = yield* fixture;
      const orgName = "alchemy-1425-owner-conflict";
      const name = "alchemy-1425-owner-conflict";
      const program = (move: boolean, cleanup = false) =>
        Effect.gen(function* () {
          const org = yield* Organization("Org", {
            owner,
            username: orgName,
          }).pipe(destroy());
          return yield* Repository(cleanup ? "Foreign" : "Repo", {
            owner: move ? org.username : owner,
            name,
            description: "managed",
          }).pipe(destroy(), adopt(cleanup));
        });
      const first = yield* stack.deploy(program(false));
      const foreign = yield* Services.organization.createOrgRepo({
        org: orgName,
        name,
        description: "foreign",
      });
      const refused = yield* stack.deploy(program(true)).pipe(Effect.result);
      const predecessor = yield* Services.repository.repoGetByID({
        id: first.repoId,
      });
      const untouched = yield* Services.repository.repoGetByID({
        id: foreign.id,
      });
      yield* stack.deploy(program(true, true));
      yield* stack.destroy();
      expect(JSON.stringify(refused)).toContain("OwnedBySomeoneElse");
      expect(predecessor.id).toBe(first.repoId);
      expect(untouched.description).toBe("foreign");
    }),
  { timeout: 90_000 },
);

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

      // Nothing changed, so neither write should be re-issued: a no-op PATCH
      // still counts as a write, bumping the repository's timestamps and
      // reporting an update on a deploy that had nothing to do.
      expect(server.count("PATCH", "/repos/alice/alchemy")).toBe(0);
      expect(server.count("PUT", "/repos/alice/alchemy/topics")).toBe(0);
    }),
);
