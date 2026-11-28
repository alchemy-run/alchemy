import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as GitHub from "@alchemy.run/github";
import * as Gateway from "alchemy/Gateway";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Repo } from "./e2b-git.ts";

/** A plain image: the sandboxes made from it run no Alchemy program. */
export const PlainSandbox = E2B.Template("GatewayPlainSandbox", { fromTemplate: "base" });

/**
 * A trusted Worker that creates sandboxes at run time and lets each push to
 * one repository. `GitHub.PushRepository` runs in the Worker's gateway, so
 * what the Worker hands a sandbox is the gateway's address and token, never
 * the GitHub token. `E2B.CreateSandbox` stays on the Worker.
 */
export default class DelegatingWorker extends Cloudflare.Worker<DelegatingWorker>()(
  "GatewayDelegatingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(PlainSandbox);
    const repo = yield* GitHub.PushRepository(Repo);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const branch = new URL(request.url, "http://worker").searchParams.get("branch") ?? "";
        const { url, env } = yield* repo.remote;
        const sandbox = yield* sandboxes.create({ timeout: 300 });
        return yield* Effect.gen(function* () {
          const pushed = yield* sandbox.exec(
            [
              "sh",
              "-c",
              [
                `git clone --depth 1 "$REMOTE" work`,
                "cd work",
                `echo "pushed to $BRANCH" > from-plain-sandbox.txt`,
                "git add from-plain-sandbox.txt",
                `git -c user.name=alchemy -c user.email=alchemy@example.com commit -q -m "pushed from a plain sandbox"`,
                `git push -q --force "$REMOTE" "HEAD:refs/heads/$BRANCH"`,
                "git rev-parse HEAD",
              ].join(" && "),
            ],
            { env: { ...env, REMOTE: url, BRANCH: branch } },
          );
          // Everything the sandbox was given, and everything else it can read.
          const environment = yield* sandbox.exec("env", { env });
          return yield* HttpServerResponse.json({
            exitCode: pushed.exitCode,
            stderr: pushed.stderr,
            sha: pushed.stdout.trim().split("\n").at(-1),
            remote: url,
            token: /gh[opsu]_|github_pat_/.test(environment.stdout),
          });
        }).pipe(Effect.ensuring(Effect.ignore(sandbox.kill())));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        E2B.CreateSandboxHttp,
        GitHub.PushRepositoryHttp.pipe(Layer.provide(Gateway.only(GitHub.PushRepository))),
      ).pipe(Layer.provide(Cloudflare.Workers.SandboxGateway)),
    ),
  ),
) {}
