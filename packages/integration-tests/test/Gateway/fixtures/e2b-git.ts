import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as GitHub from "@alchemy.run/github";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { ChildProcess } from "effect/process";
import * as Stream from "effect/Stream";

export const owner = "alchemy-run-test";
export const repository = "alchemy-gateway-git";

// Public and retained across runs: the gh token lacks delete_repo.
export const Repo = GitHub.Repository("GatewayGitRepo", {
  owner,
  name: repository,
  visibility: "public",
  description: "Retained deterministic fixture for the sandbox gateway's git push test",
  autoInit: true,
});

/**
 * A sandbox program that pushes a commit with the `git` CLI. The remote is
 * its gateway, which holds the GitHub token.
 */
export default class GitSandbox extends E2B.Template<GitSandbox>()(
  "GatewayGitSandbox",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const repo = yield* GitHub.PushRepository(Repo);
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const branch = new URL(request.url, "http://sandbox").searchParams.get("branch") ?? "";
        const { url, env } = yield* repo.remote;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gateway-git-" });
        const git = (...args: string[]) =>
          Effect.gen(function* () {
            const process = yield* ChildProcess.make("git", args, {
              cwd: dir,
              env,
              extendEnv: true,
              stdout: "pipe",
              stderr: "pipe",
            });
            const [stdout, stderr, code] = yield* Effect.all(
              [
                process.stdout.pipe(Stream.decodeText(), Stream.mkString),
                process.stderr.pipe(Stream.decodeText(), Stream.mkString),
                process.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return code === 0
              ? stdout.trim()
              : yield* Effect.fail(new Error(`git ${args[0]} exited ${code}: ${stderr}`));
          });
        yield* git("clone", "--depth", "1", url, ".");
        yield* fs.writeFileString(`${dir}/from-sandbox.txt`, `pushed to ${branch}\n`);
        yield* git("add", "from-sandbox.txt");
        yield* git(
          "-c",
          "user.name=alchemy",
          "-c",
          "user.email=alchemy@example.com",
          "commit",
          "-m",
          "pushed through the gateway",
        );
        const sha = yield* git("rev-parse", "HEAD");
        yield* git("push", "--force", url, `HEAD:refs/heads/${branch}`);
        const environment = JSON.stringify(yield* Effect.sync(() => process.env));
        return yield* HttpServerResponse.json({
          sha,
          remote: url,
          // The sandbox holds no GitHub token, in its env or in git's.
          token: /gh[opsu]_|github_pat_/.test(environment + JSON.stringify(env)),
        });
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      GitHub.PushRepositoryHttp.pipe(Layer.provide(Cloudflare.Workers.SandboxGateway)),
    ),
  ),
) {}
