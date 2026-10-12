import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Test from "@/Test/Alchemy";
import type { Shell } from "./fixtures/egress/object.ts";
import { EGRESS_REPO } from "./fixtures/egress/repo.ts";
import EgressStack, { providers, state } from "./fixtures/egress/stack.ts";

const HOOK_TIMEOUT = 600_000;

/**
 * `gh` and `git` in a container that holds only a placeholder token: its
 * Durable Object's `GitHub.Egress` checks each request against the declared
 * repository access and adds the real token.
 */
describe.each([
  { dev: true, mode: "local" },
  { dev: false, mode: "live" },
])("GitHub.Egress (dev: $dev)", ({ dev, mode }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state, dev });
  const stack = beforeAll(deploy(EgressStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(EgressStack), { timeout: HOOK_TIMEOUT });

  const sh = (script: string, options: { issue?: number } = {}) =>
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const target = new URL("/", url);
      if (options.issue !== undefined) target.searchParams.set("issue", String(options.issue));
      const text = yield* client
        .execute(HttpClientRequest.post(target).pipe(HttpClientRequest.bodyText(script)))
        .pipe(
          Effect.flatMap((r) =>
            r.status !== 200
              ? r.text.pipe(
                  Effect.flatMap((body) => Effect.fail(new Error(`${r.status}: ${body}`))),
                )
              : r.text,
          ),
          Effect.timeout("120 seconds"),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
      return JSON.parse(text) as Shell;
    });

  const options = { tags: [mode, "provider:github", "provider:cloudflare"], timeout: 600_000 };

  test(
    "gh is signed in with only a placeholder token",
    Effect.gen(function* () {
      const env = yield* sh("echo $GH_TOKEN");
      expect(env.stdout.trim()).toBe("alchemy-egress");
      const user = yield* sh("gh api user --jq .login");
      expect(user.exitCode, user.stderr).toBe(0);
      expect(user.stdout.trim().length).toBeGreaterThan(0);
    }),
    options,
  );

  test(
    "git clones and pushes agent branches; main and other repositories are refused",
    Effect.gen(function* () {
      const result = yield* sh(`
        set -x
        rm -rf repo && git clone https://github.com/${EGRESS_REPO}.git repo && cd repo
        git config user.email agent@example.com && git config user.name agent
        git checkout -b agent/egress-test && date > stamp && git add stamp && git commit -qm stamp
        git push -f origin agent/egress-test && echo PUSH_AGENT_OK
        git push origin HEAD:main && echo PUSH_MAIN_OK
        gh api repos/cli/cli --jq .full_name && echo OTHER_REPO_OK
        true
      `);
      expect(result.stdout, result.stderr).toContain("PUSH_AGENT_OK");
      expect(result.stdout).not.toContain("PUSH_MAIN_OK");
      expect(result.stderr).toContain("[remote rejected]");
      expect(result.stderr).toContain("push to refs/heads/main is not allowed");
      expect(result.stdout).not.toContain("OTHER_REPO_OK");
      expect(result.stderr).toContain("cli/cli is not an allowed repository");
    }),
    options,
  );

  test(
    "a narrowed egress writes only to its issue",
    Effect.gen(function* () {
      const created = yield* sh(
        `gh issue create --repo ${EGRESS_REPO} --title "egress test" --body "egress test" | tail -1`,
      );
      expect(created.exitCode, created.stderr).toBe(0);
      const issue = Number(created.stdout.trim().split("/").pop());
      const other = yield* sh(
        `gh issue create --repo ${EGRESS_REPO} --title "egress other" --body "egress other" | tail -1`,
      );
      const otherIssue = Number(other.stdout.trim().split("/").pop());

      const own = yield* sh(`gh issue comment ${issue} --repo ${EGRESS_REPO} --body ok`, { issue });
      expect(own.exitCode, own.stderr).toBe(0);
      const elsewhere = yield* sh(
        `gh issue comment ${otherIssue} --repo ${EGRESS_REPO} --body nope`,
        { issue },
      );
      expect(elsewhere.exitCode).not.toBe(0);
      expect(elsewhere.stderr).toContain(`this session works on #${issue} only`);

      yield* sh(
        `gh issue close ${issue} --repo ${EGRESS_REPO}; gh issue close ${otherIssue} --repo ${EGRESS_REPO}`,
      );
    }),
    options,
  );
});
