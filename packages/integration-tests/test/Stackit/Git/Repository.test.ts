import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGone,
  observeInstance,
  observeRepository,
  slow,
  TEST_PASSWORD,
  withUser,
} from "./git.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("git", "repository"), timeout: 1_800_000 } as const;

const USERNAME = "alchemy-test-repo-owner";

type RepositoryOptions = Omit<Stackit.Git.RepositoryProps, "instanceUrl" | "username" | "password">;

/** An instance with a technical user, and repositories managed as that user. */
const app = (repositories: Record<string, RepositoryOptions>, adopting = false) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Git.Instance("RepositoryInstance", {
      featureToggle: { enableLocalLogin: true },
      forceDestroy: true,
    });
    const user = yield* Stackit.Git.User("RepositoryUser", {
      instanceId: instance.instanceId,
      username: USERNAME,
      email: `${USERNAME}@example.com`,
      name: "Alchemy test repository owner",
      password: Redacted.make(TEST_PASSWORD),
    });
    const deployed: Record<string, Stackit.Git.Repository> = {};
    for (const [id, props] of Object.entries(repositories)) {
      const repository = Stackit.Git.Repository(id, {
        instanceUrl: instance.url,
        username: user.username,
        password: Redacted.make(TEST_PASSWORD),
        ...props,
      });
      deployed[id] = yield* adopting ? repository.pipe(adopt(true)) : repository;
    }
    return { instance, user, repositories: deployed };
  });

test.provider.skipIf(slow)(
  "create, update, rename and delete a repository",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = { name: "alchemy-repo", description: "first" };
      const { instance, repositories } = yield* stack.deploy(app({ Basic: first }));
      const created = repositories.Basic!;
      expect(created.owner).toEqual(USERNAME);
      expect(created.repositoryName).toEqual("alchemy-repo");
      expect(created.private).toEqual(true);
      expect(created.createdByAlchemy).toEqual(true);
      // The login isn't in the attributes.
      expect(JSON.stringify(created)).not.toContain(TEST_PASSWORD);

      const outOfBand = <A, E, R>(use: Effect.Effect<A, E, R>) =>
        withUser(instance.url, USERNAME, use);

      // Out of band.
      const fetched = yield* outOfBand(
        forgejo.getRepository({ owner: USERNAME, repo: "alchemy-repo" }),
      );
      expect(fetched.id).toEqual(created.repositoryId);
      expect(fetched.description).toEqual("first");
      expect(fetched.private).toEqual(true);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ Basic: first }));
      expect(plan.resources.Basic).toMatchObject({ action: "noop" });

      // The settings update in place, and neighbouring ones are left alone.
      const { repositories: edited } = yield* stack.deploy(
        app({ Basic: { name: "alchemy-repo", description: "second", hasWiki: false } }),
      );
      expect(edited.Basic!.repositoryId).toEqual(created.repositoryId);
      const changed = yield* outOfBand(
        forgejo.getRepository({ owner: USERNAME, repo: "alchemy-repo" }),
      );
      expect(changed.description).toEqual("second");
      expect(changed.has_wiki).toEqual(false);
      expect(changed.private).toEqual(true);

      // A new name is a rename: the same repository, nothing replaced.
      const { repositories: renamed } = yield* stack.deploy(
        app({ Basic: { name: "alchemy-repo-renamed" } }),
      );
      expect(renamed.Basic!.repositoryId).toEqual(created.repositoryId);
      expect(renamed.Basic!.repositoryName).toEqual("alchemy-repo-renamed");
      const moved = yield* outOfBand(
        forgejo.getRepository({ owner: USERNAME, repo: "alchemy-repo-renamed" }),
      );
      expect(moved.id).toEqual(created.repositoryId);

      // An empty repository Alchemy created goes without an opt-in.
      yield* stack.deploy(app({}));
      const gone = yield* outOfBand(observeRepository(USERNAME, "alchemy-repo-renamed"));
      expect(gone).toEqual("gone");

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a repository with commits, or one Alchemy adopted, survives a delete with no forceDestroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      // A first commit makes it hold something.
      const initialized = { name: "alchemy-repo-commits", autoInit: true };
      const { instance } = yield* stack.deploy(app({ Commits: initialized }));
      const outOfBand = <A, E, R>(use: Effect.Effect<A, E, R>) =>
        withUser(instance.url, USERNAME, use);

      const notEmpty = yield* stack.deploy(app({})).pipe(Effect.flip);
      expect(notEmpty).toMatchObject({
        _tag: "Stackit.Git.RepositoryDeleteRefused",
        reason: "not-empty",
      });

      // A new owner would replace it: the plan fails, with or without an opt-in in the same
      // deploy, because the old repository's delete sees what it was deployed with.
      const otherOwner = yield* stack
        .deploy(app({ Commits: { ...initialized, owner: "someone-else", forceDestroy: true } }))
        .pipe(Effect.flip);
      expect(otherOwner).toMatchObject({
        _tag: "Stackit.Git.RepositoryDeleteRefused",
        reason: "not-empty",
      });

      const kept = yield* outOfBand(
        forgejo.getRepository({ owner: USERNAME, repo: "alchemy-repo-commits" }),
      );
      expect(kept.empty).toEqual(false);

      // Once it opts in, it goes.
      yield* stack.deploy(app({ Commits: { ...initialized, forceDestroy: true } }));
      yield* stack.deploy(app({}));
      const gone = yield* outOfBand(observeRepository(USERNAME, "alchemy-repo-commits"));
      expect(gone).toEqual("gone");

      // A repository that was already there isn't taken over without `--adopt`.
      const foreign = yield* outOfBand(
        forgejo.createCurrentUserRepository({ name: "alchemy-repo-foreign" }),
      );
      const refused = yield* stack
        .deploy(app({ Adopted: { name: "alchemy-repo-foreign" } }))
        .pipe(Effect.flip);
      expect(refused._tag).toEqual("OwnedBySomeoneElse");

      // Adopted, it updates in place, keeps its id, and stays recorded as not ours.
      const { repositories } = yield* stack.deploy(
        app({ Adopted: { name: "alchemy-repo-foreign", description: "adopted" } }, true),
      );
      const adopted = repositories.Adopted!;
      expect(adopted.repositoryId).toEqual(foreign.id);
      expect(adopted.createdByAlchemy).toEqual(false);

      const notOurs = yield* stack.deploy(app({})).pipe(Effect.flip);
      expect(notOurs).toMatchObject({
        _tag: "Stackit.Git.RepositoryDeleteRefused",
        reason: "adopted",
      });
      const survivor = yield* outOfBand(
        forgejo.getRepository({ owner: USERNAME, repo: "alchemy-repo-foreign" }),
      );
      expect(survivor.id).toEqual(foreign.id);
      expect(survivor.description).toEqual("adopted");

      // A repository with another id under the recorded name is someone else's.
      yield* outOfBand(forgejo.deleteRepository({ owner: USERNAME, repo: "alchemy-repo-foreign" }));
      const replacement = yield* outOfBand(
        forgejo.createCurrentUserRepository({ name: "alchemy-repo-foreign" }),
      );
      expect(replacement.id).not.toEqual(foreign.id);
      yield* stack.deploy(app({}));
      const untouched = yield* outOfBand(
        forgejo.getRepository({ owner: USERNAME, repo: "alchemy-repo-foreign" }),
      );
      expect(untouched.id).toEqual(replacement.id);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);
