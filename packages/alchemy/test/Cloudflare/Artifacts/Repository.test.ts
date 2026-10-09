import * as artifacts from "@distilled.cloud/cloudflare/artifacts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** Shared implicit namespace; repo names are engine-generated per stage. */
const NAMESPACE = "alchemy-test-artifacts";

/** Small public repository used to exercise `import`. */
const IMPORT_URL = "https://github.com/octocat/Hello-World";

const tags = ["provider:cloudflare", "provider:cloudflare:artifacts", "live"];

class RepositoryStillExists extends Data.TaggedError("RepositoryStillExists")<{
  name: string;
}> {}

/** Wait (bounded) until the repository is gone, verified out of band. */
const waitForRepositoryGone = (accountId: string, namespace: string, name: string) =>
  artifacts.getRepo({ accountId, namespace, name }).pipe(
    Effect.flatMap(() => Effect.fail(new RepositoryStillExists({ name }))),
    Effect.catchTag("ArtifactsRepositoryNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RepositoryStillExists",
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

test.provider(
  "create, replace and delete a repository",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const v1 = yield* stack.deploy(
        Cloudflare.Artifacts.Repository("Repo", {
          namespace: NAMESPACE,
          description: "v1",
        }),
      );
      expect(v1.namespace).toBe(NAMESPACE);
      expect(v1.defaultBranch).toBe("main");
      expect(v1.description).toBe("v1");
      expect(v1.readOnly).toBe(false);
      expect(v1.remote).toBe(
        `https://${accountId}.artifacts.cloudflare.net/git/${NAMESPACE}/${v1.name}.git`,
      );

      const observed = yield* artifacts.getRepo({ accountId, namespace: NAMESPACE, name: v1.name });
      expect(observed.id).toBe(v1.repositoryId);
      expect(observed.description).toBe("v1");

      // Idempotent redeploy: no change, same repository.
      const again = yield* stack.deploy(
        Cloudflare.Artifacts.Repository("Repo", {
          namespace: NAMESPACE,
          description: "v1",
        }),
      );
      expect(again.repositoryId).toBe(v1.repositoryId);

      // Artifacts has no update API — a description change replaces the
      // repository (new generated name), and the old one is deleted.
      const v2 = yield* stack.deploy(
        Cloudflare.Artifacts.Repository("Repo", {
          namespace: NAMESPACE,
          description: "v2",
          defaultBranch: "trunk",
        }),
      );
      expect(v2.repositoryId).not.toBe(v1.repositoryId);
      expect(v2.description).toBe("v2");
      expect(v2.defaultBranch).toBe("trunk");
      yield* waitForRepositoryGone(accountId, NAMESPACE, v1.name);

      const observedV2 = yield* artifacts.getRepo({
        accountId,
        namespace: NAMESPACE,
        name: v2.name,
      });
      expect(observedV2.defaultBranch).toBe("trunk");

      yield* stack.destroy();
      yield* waitForRepositoryGone(accountId, NAMESPACE, v2.name);
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "import a public repository and fork it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const { mirror, fork } = yield* stack.deploy(
        Effect.gen(function* () {
          const mirror = yield* Cloudflare.Artifacts.Repository("Mirror", {
            namespace: NAMESPACE,
            import: { url: IMPORT_URL, depth: 1 },
          });
          const fork = yield* Cloudflare.Artifacts.Repository("Fork", {
            namespace: NAMESPACE,
            description: "fork of mirror",
            fork: { repository: mirror.name },
          });
          return { mirror, fork };
        }),
      );
      expect(mirror.source).toBeDefined();
      expect(fork.source).toContain(mirror.name);

      // The imported content is readable out of band through the REST API.
      const log = yield* artifacts.getRepoLog({
        accountId,
        namespace: NAMESPACE,
        name: mirror.name,
        limit: 1,
      });
      expect(log.length).toBe(1);
      const forkLog = yield* artifacts.getRepoLog({
        accountId,
        namespace: NAMESPACE,
        name: fork.name,
        limit: 1,
      });
      expect(forkLog[0]?.hash).toBe(log[0]?.hash);

      yield* stack.destroy();
      yield* waitForRepositoryGone(accountId, NAMESPACE, fork.name);
      yield* waitForRepositoryGone(accountId, NAMESPACE, mirror.name);
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
