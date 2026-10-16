import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Test from "@/Test/Alchemy";
import { DRIP_HOST, REPO_A, REPO_B } from "./fixtures/sandbox/gateways.ts";
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

/** Run a shell script in the sandbox (the container must be running). */
const sh = (script: string) => Effect.map(call("/sh", script), (body) => JSON.parse(body) as Shell);

/** `key=value` lines of a script's stdout. */
const fields = (shell: Shell) =>
  Object.fromEntries(
    shell.stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  ) as Record<string, string | undefined>;

/** The gateway (A, B, or "" for none) that answered each request, from its response header. */
const landed = Effect.gen(function* () {
  const gateway = `grep -io 'x-alchemy-test-gateway: [A-Z]' | head -1 | cut -d' ' -f2`;
  return fields(
    yield* sh(
      `
      git_via() { GIT_CURL_VERBOSE=1 git ls-remote "https://github.com/$1" HEAD 2>&1 | ${gateway}; }
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
  );
});

/** `seconds` of httpbin's drip (one byte a second) through gateway A. */
const drip = (seconds: number) =>
  sh(
    `curl -sS -D /tmp/drip.h -o /tmp/drip.b -w 'code=%{http_code}\nsize=%{size_download}\nsecs=%{time_total}\n' "https://${DRIP_HOST}/drip?duration=${seconds}&numbytes=${seconds}&delay=0"
    echo "exit=$?"
    echo "via=$(grep -io 'x-alchemy-test-gateway: [A-Z]' /tmp/drip.h | head -1 | cut -d' ' -f2)"`,
  ).pipe(Effect.map(fields));

/**
 * A Cloudflare sandbox granted GitHub egress from two gateways that share
 * `github.com` and `api.github.com` by path, plus gateway A's drip on a
 * host of its own: each request is intercepted into the Worker's
 * `AlchemyEgress` relay, which mints the gateway's grant itself and
 * forwards to the gateway whose route matches.
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
    "setEgress narrows at once, without touching a host whose egress is unchanged",
    Effect.gen(function* () {
      // A transfer on the drip's host, in flight across setEgress.
      const transfer = yield* Effect.forkChild(drip(25));
      yield* Effect.sleep("5 seconds");
      yield* call("/narrow");
      // B's repository is refused at once: its paths go straight out with
      // the placeholder token, which GitHub rejects.
      const refused = fields(
        yield* sh(
          `s=$(date +%s); gh api -i "repos/${REPO_B}" > /tmp/ghB 2>&1; echo "exit=$?"; echo "secs=$(( $(date +%s) - s ))"; echo "status=$(head -1 /tmp/ghB | cut -d' ' -f2)"; echo "via=$(grep -io 'x-alchemy-test-gateway: [A-Z]' /tmp/ghB | head -1 | cut -d' ' -f2)"`,
        ),
      );
      expect(refused).toMatchObject({ status: "401", via: "" });
      expect(refused.exit).not.toBe("0");
      expect(Number(refused.secs)).toBeLessThan(10);
      const via = yield* landed;
      expect(via.gitA).toBe("A");
      // B's routes are gone: its repository goes straight out.
      expect(via.gitB).toBe("");
      expect(via.ghB).toBe("");
      // The drip's host kept its intercept: the transfer finished, whole.
      const dripped = yield* Fiber.join(transfer);
      expect(dripped).toMatchObject({ exit: "0", code: "200", size: "25", via: "A" });
      expect(Number(dripped.secs)).toBeGreaterThanOrEqual(24);
    }),
    options,
  );

  test(
    "grants renew in the relay: no request fails across many expiries",
    Effect.gen(function* () {
      yield* call("/start?ttl=10000");
      // Past the first grants' expiry: only the relay's renewal keeps the routes working.
      yield* Effect.sleep("15 seconds");
      const via = yield* landed;
      expect(via).toMatchObject({ gitA: "A", gitB: "B", okA: "1" });
      // 24 requests over 30+ seconds (three-plus 10-second grants each): none
      // is refused or reset, with no retry.
      const loop = fields(
        yield* sh(
          `s=$(date +%s); fails=0
          for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
            for r in ${REPO_A} ${REPO_B}; do
              out=$(git ls-remote "https://github.com/$r" HEAD 2>&1) || { fails=$((fails + 1)); echo "failed $r: $(echo "$out" | tail -1)" >&2; }
            done
            sleep 1.5
          done
          echo "fails=$fails"; echo "secs=$(( $(date +%s) - s ))"`,
        ),
      );
      expect(loop.fails).toBe("0");
      expect(Number(loop.secs)).toBeGreaterThanOrEqual(30);
    }),
    options,
  );

  test(
    "a transfer outlives several grant expiries",
    Effect.gen(function* () {
      // ttl is still 10 seconds. A throttled fetch of REPO_A's pack (far
      // larger than 64 KB/s for 40 s): curl's own deadline (exit 28) ends it,
      // never a reset.
      const pack = fields(
        yield* sh(
          `sha=$(git ls-remote "https://github.com/${REPO_A}" HEAD | cut -f1)
          printf '0032want %s\\n00000009done\\n' "$sha" | curl -sS --limit-rate 64k --max-time 40 -X POST \\
            -H 'Content-Type: application/x-git-upload-pack-request' --data-binary @- \\
            -D /tmp/pack.h -o /tmp/pack -w 'code=%{http_code}\\nsize=%{size_download}\\nsecs=%{time_total}\\n' \\
            "https://github.com/${REPO_A}.git/git-upload-pack"
          echo "exit=$?"
          echo "via=$(grep -io 'x-alchemy-test-gateway: [A-Z]' /tmp/pack.h | head -1 | cut -d' ' -f2)"`,
        ),
      );
      expect(pack).toMatchObject({ code: "200", exit: "28", via: "A" });
      expect(Number(pack.secs)).toBeGreaterThanOrEqual(39);
      expect(Number(pack.size)).toBeGreaterThan(1_000_000);
    }),
    options,
  );

  test(
    "after the Durable Object restarts, its stored egress keeps working",
    Effect.gen(function* () {
      yield* call("/abort");
      // Nothing calls start: the new instance re-registers what's stored.
      expect(JSON.parse(yield* call("/running"))).toBe(true);
      // Past the old grants' expiry: the relay mints fresh ones.
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
