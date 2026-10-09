import * as artifacts from "@distilled.cloud/cloudflare/artifacts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const NAMESPACE = "alchemy-test-artifacts";
const IMPORT_URL = "https://github.com/octocat/Hello-World";

/** Run `git` with the given args; returns `{ code, stdout, stderr }`. */
const git = (args: string[]) =>
  Effect.gen(function* () {
    const proc = yield* ChildProcess.make("git", args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, code] = yield* Effect.all(
      [
        proc.stdout.pipe(Stream.decodeText(), Stream.runCollect),
        proc.stderr.pipe(Stream.decodeText(), Stream.runCollect),
        proc.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { code, stdout: [...stdout].join(""), stderr: [...stderr].join("") };
  }).pipe(Effect.scoped);

const tokenStates = (accountId: string, name: string) =>
  artifacts.listRepoTokens.items({ accountId, namespace: NAMESPACE, name, state: "all" }).pipe(
    Stream.runCollect,
    Effect.map((c) => new Map(Array.from(c, (t) => [t.id, t.state]))),
  );

test.provider(
  "mint, rotate and revoke a repository token; clone with it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deployWith = (scope: "read" | "write") =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* Cloudflare.Artifacts.Repository("TokenRepo", {
              namespace: NAMESPACE,
              import: { url: IMPORT_URL, depth: 1 },
            });
            const token = yield* Cloudflare.Artifacts.RepositoryToken("Token", {
              repository: repo,
              scope,
              ttl: 600,
            });
            return { repo, token };
          }),
        );

      const { repo, token } = yield* deployWith("read");
      expect(token.scope).toBe("read");
      expect(token.repository).toBe(repo.name);
      expect(token.namespace).toBe(NAMESPACE);
      expect(token.remote).toBe(repo.remote);
      expect(Redacted.value(token.token)).toMatch(/^art_v\d+_.+\?expires=\d+$/);
      expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());

      // Out of band: the token is active on the repository.
      expect((yield* tokenStates(accountId, repo.name)).get(token.tokenId)).toBe("active");

      // The credential helper authenticates git over HTTPS — Basic auth URL
      // and Bearer `http.extraHeader` forms.
      const cred = Cloudflare.Artifacts.gitCredential(repo.remote, token.token);
      expect(cred.username).toBe("x");
      expect(cred.password).not.toContain("?expires=");
      const viaUrl = yield* git(["ls-remote", cred.url]);
      expect(viaUrl.code).toBe(0);
      expect(viaUrl.stdout).toContain("refs/heads/");
      const viaHeader = yield* git([
        "-c",
        `http.extraHeader=${cred.extraHeader}`,
        "ls-remote",
        repo.remote,
      ]);
      expect(viaHeader.code).toBe(0);
      expect(viaHeader.stdout).toContain("refs/heads/");

      // A bogus secret is rejected — proves the token is what authenticates.
      const denied = yield* git([
        "ls-remote",
        Cloudflare.Artifacts.gitCredential(repo.remote, "art_v1_deadbeef").url,
      ]);
      expect(denied.code).not.toBe(0);

      // Idempotent redeploy keeps the same token.
      const same = yield* deployWith("read");
      expect(same.token.tokenId).toBe(token.tokenId);

      // Changing the scope mints a new token and revokes the old one.
      const rotated = yield* deployWith("write");
      expect(rotated.token.tokenId).not.toBe(token.tokenId);
      expect(rotated.token.scope).toBe("write");
      const states = yield* tokenStates(accountId, repo.name);
      expect(states.get(rotated.token.tokenId)).toBe("active");
      expect(states.get(token.tokenId)).toBe("revoked");

      yield* stack.destroy();
      const gone = yield* artifacts
        .getRepo({ accountId, namespace: NAMESPACE, name: repo.name })
        .pipe(
          Effect.as(false),
          Effect.catchTag("ArtifactsRepositoryNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:artifacts", "live"], timeout: 120_000 },
);
