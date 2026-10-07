import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as GitHub from "@/GitHub/index.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy.ts";

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (!["alchemy-run-test", "alchemy-run-test-2"].includes(owner)) {
  throw new Error("GITHUB_TEST_OWNER must be alchemy-run-test or alchemy-run-test-2");
}

const repoNameOf = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (name) => name.split("/")[1]!);

/** `git ls-remote` over SSH with the key: proves GitHub accepts it for this repository. */
const lsRemote = (privateKey: Redacted.Redacted<string>, repoName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "deploy-key-" });
    const keyFile = path.join(dir, "id");
    yield* fs.writeFileString(keyFile, Redacted.value(privateKey), { mode: 0o600 });
    const spawner = yield* ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("git", ["ls-remote", `git@github.com:${owner}/${repoName}.git`], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        env: {
          GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(dir, "known_hosts")}`,
        },
      }),
    );
    const [exitCode, stdout] = yield* Effect.all(
      [child.exitCode, child.stdout.pipe(Stream.decodeText, Stream.mkString)],
      { concurrency: "unbounded" },
    );
    return { exitCode, stdout };
  }).pipe(Effect.scoped);

test.provider(
  "a deploy key gives git access to its repository, and is replaced to change access",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const repoName = "test-deploy-key";
      const program = (readOnly: boolean) =>
        Effect.gen(function* () {
          const repo = yield* GitHub.Repository("deploy-key-repo", {
            owner,
            name: repoName,
            autoInit: true,
            visibility: "private",
          });
          const key = yield* GitHub.DeployKey("agent", {
            owner,
            repository: repoNameOf(repo),
            readOnly,
          });
          return { key };
        });

      const { key } = yield* stack.deploy(program(true));
      expect(key.readOnly).toBe(true);
      expect(key.publicKey).toMatch(/^ssh-ed25519 /);

      const client = yield* Octokit;
      const observed = yield* Effect.tryPromise(() =>
        client.rest.repos.getDeployKey({ owner, repo: repoName, key_id: key.keyId }),
      );
      expect(observed.data.read_only).toBe(true);
      expect(key.publicKey.startsWith(observed.data.key)).toBe(true);

      // The generated private key authenticates git to this (private) repository.
      const remote = yield* lsRemote(key.privateKey, repoName);
      expect(remote.exitCode).toBe(0);
      expect(remote.stdout).toContain("refs/heads/");

      // A redeploy keeps the same key.
      const again = yield* stack.deploy(program(true));
      expect(again.key.keyId).toBe(key.keyId);

      // Keys are immutable: making it read-write replaces it.
      const { key: writable } = yield* stack.deploy(program(false));
      expect(writable.readOnly).toBe(false);
      expect(writable.keyId).not.toBe(key.keyId);
      const keys = yield* Effect.tryPromise(() =>
        client.rest.repos.listDeployKeys({ owner, repo: repoName }),
      );
      expect(keys.data.map((k) => k.id)).toEqual([writable.keyId]);

      yield* stack.destroy();
      const gone = yield* Effect.tryPromise(() =>
        client.rest.repos.getDeployKey({ owner, repo: repoName, key_id: writable.keyId }),
      ).pipe(
        Effect.map(() => false),
        Effect.catch(() => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:github", "provider:github:deploy-key", "live"],
    timeout: 120_000,
  },
);
