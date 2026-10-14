import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Test from "@/Test/Alchemy";
import { REPO_A, REPO_B } from "./fixtures/sandbox/gateways.ts";
import type { Shell } from "./fixtures/sandbox/object.ts";
import SandboxStack, { providers, state } from "./fixtures/sandbox/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });
const stack = beforeAll(deploy(SandboxStack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(SandboxStack), { timeout: 600_000 });

const options = { tags: ["live", "provider:github", "provider:cloudflare"], timeout: 300_000 };

const call = (path: string, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.post(new URL(path, url)).pipe(HttpClientRequest.bodyText(body ?? "")),
      )
      .pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? r.text.pipe(Effect.flatMap((text) => Effect.fail(new Error(`${r.status}: ${text}`))))
            : r.text,
        ),
        Effect.timeout("120 seconds"),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
      );
  });

/** The gateway (A, B, or "" for none) that answered each request, from its response header. */
const landed = Effect.gen(function* () {
  const gateway = `grep -io 'x-alchemy-test-gateway: [A-Z]' | head -1 | cut -d' ' -f2`;
  const shell = JSON.parse(
    yield* call(
      "/sh",
      `
      # Retried: re-registering an intercept (each renewal) can reset a TLS
      # handshake in flight. A refused grant would fail every attempt.
      git_via() { for i in 1 2 3; do v=$(GIT_CURL_VERBOSE=1 git ls-remote "https://github.com/$1" HEAD 2>&1 | ${gateway}); [ -n "$v" ] && break; sleep 1; done; echo "$v"; }
      gh_via() { gh api -i "repos/$1" 2>&1 | ${gateway}; }
      echo "gitA=$(git_via ${REPO_A})"
      echo "gitB=$(git_via ${REPO_B})"
      echo "ghA=$(gh_via ${REPO_A})"
      echo "ghB=$(gh_via ${REPO_B})"
      echo "gitOther=$(git_via cli/cli)"
      git ls-remote https://github.com/${REPO_A} HEAD >/dev/null 2>&1 && echo okA=1
      git ls-remote https://github.com/cli/cli HEAD >/dev/null 2>&1 && echo okOther=1
      true
      `,
    ),
  ) as Shell;
  return Object.fromEntries(
    shell.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=") as [string, string]),
  ) as Record<string, string | undefined>;
});

/**
 * A Cloudflare sandbox granted GitHub egress from two gateways that share
 * `github.com` and `api.github.com` by path: each request is intercepted
 * into the Worker's `AlchemyEgress` relay and lands on the gateway whose
 * route matches it.
 */
describe.sequential("Cloudflare sandbox egress", () => {
  test(
    "each request lands on the gateway whose path matches; others go straight out",
    Effect.gen(function* () {
      yield* call("/start?ttl=300000");
      const via = yield* landed;
      expect(via).toMatchObject({ gitA: "A", gitB: "B", ghA: "A", ghB: "B", gitOther: "" });
      expect(via.okA).toBe("1");
      expect(via.okOther).toBe("1");
    }),
    options,
  );

  test(
    "setEgress narrows the running sandbox at once",
    Effect.gen(function* () {
      yield* call("/narrow");
      const via = yield* landed;
      expect(via.gitA).toBe("A");
      // B's routes are gone: its repository goes straight out.
      expect(via.gitB).toBe("");
      expect(via.ghB).toBe("");
    }),
    options,
  );

  test(
    "grants are renewed before they expire",
    Effect.gen(function* () {
      yield* call("/start?ttl=10000");
      // Past the first grants' expiry: only renewal keeps the routes working.
      yield* Effect.sleep("15 seconds");
      const via = yield* landed;
      expect(via).toMatchObject({ gitA: "A", gitB: "B", okA: "1" });
      const loop = JSON.parse(
        yield* call(
          "/sh",
          `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do for r in ${REPO_A} ${REPO_B}; do GIT_CURL_VERBOSE=1 git ls-remote https://github.com/$r HEAD 2>&1 | grep -iE '^< HTTP/[0-9.]+ [0-9]+' | grep -vE ' 200' | sed "s|^|$r |"; done; sleep 1; done; echo end`,
        ),
      ) as Shell;
      // 24 requests across six renewals: none is refused (an expired grant is a 401).
      expect(loop.stdout.trim()).toBe("end");
    }),
    options,
  );

  test(
    "after the Durable Object restarts, its stored egress keeps working",
    Effect.gen(function* () {
      yield* call("/abort");
      // Nothing calls start: the new instance re-applies what's stored, and
      // its renewal outlives the old instance's 10-second grants.
      expect(JSON.parse(yield* call("/running"))).toBe(true);
      yield* Effect.sleep("15 seconds");
      const via = yield* landed;
      expect(via).toMatchObject({ gitA: "A", gitB: "B", okA: "1" });
    }),
    options,
  );

  test(
    "stop clears the routes; start re-applies what's stored",
    Effect.gen(function* () {
      yield* call("/stop");
      yield* call("/start?ttl=300000");
      const via = yield* landed;
      expect(via).toMatchObject({ gitA: "A", gitB: "B" });
    }),
    options,
  );
});
