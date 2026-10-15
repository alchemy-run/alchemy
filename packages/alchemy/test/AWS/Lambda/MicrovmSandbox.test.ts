import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Test from "@/Test/Alchemy";
import { REPO_A, REPO_B } from "./fixtures/microvm-sandbox/gateway.ts";
import type { Shell } from "./fixtures/microvm-sandbox/object.ts";
import SandboxStack, { providers, state } from "./fixtures/microvm-sandbox/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });

// Lambda MicroVM is a preview: the account must be onboarded, with a
// bootstrapped Assets bucket. Builds (two images, one per size) take minutes.
const skip = !process.env.LAMBDA_TEST_MICROVM;

const options = {
  tags: [
    "live",
    "provider:aws",
    "provider:aws:lambda",
    "provider:cloudflare",
    "provider:cloudflare:worker",
    "provider:github",
  ],
  timeout: 300_000,
};

describe.skipIf(skip).sequential("AWS Lambda MicroVM sandbox", () => {
  const stack = beforeAll(deploy(SandboxStack), { timeout: 1_500_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(SandboxStack), { timeout: 1_500_000 });

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
              ? r.text.pipe(
                  Effect.flatMap((text) => Effect.fail(new Error(`${r.status}: ${text}`))),
                )
              : r.text,
          ),
          Effect.timeout("150 seconds"),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 6 }),
        );
    });

  /** Run a shell script in the sandbox (the MicroVM must be running). */
  const sh = (script: string) =>
    Effect.map(call("/sh", script), (body) => JSON.parse(body) as Shell);

  /** Run a shell script with `sandbox.exec` (the MicroVM must be running). */
  const exec = (script: string) =>
    Effect.map(
      call(`/exec?script=${encodeURIComponent(script)}`, ""),
      (body) => JSON.parse(body) as Shell,
    );

  /** `key=value` lines of a script's stdout. */
  const fields = (shell: Shell) =>
    Object.fromEntries(
      shell.stdout
        .trim()
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ) as Record<string, string | undefined>;

  const debug = Effect.map(
    call("/debug"),
    (body) =>
      JSON.parse(body) as {
        ttl?: number;
        egress?: number;
        microvm?: { id: string; size: string };
      },
  );

  /**
   * For each repository: the REST API's status and rate limit with the
   * placeholder token, whether the gateway answered, and `git ls-remote`.
   */
  const probe = sh(
    `
    api() {
      curl -sS -D /tmp/h -o /dev/null -w '%{http_code}' -H "Authorization: token $GH_TOKEN" "https://api.github.com/repos/$1"
    }
    for r in A:${REPO_A} B:${REPO_B} other:cli/cli; do
      name=\${r%%:*}; repo=\${r#*:}
      echo "status$name=$(api $repo)"
      echo "limit$name=$(grep -i '^x-ratelimit-limit:' /tmp/h | tr -d '\\r' | cut -d' ' -f2)"
      echo "via$name=$(grep -ci '^x-alchemy-test-gateway:' /tmp/h)"
    done
    git ls-remote "https://github.com/${REPO_A}" HEAD >/dev/null 2>&1 && echo gitA=1
    git ls-remote https://github.com/cli/cli HEAD 2>&1 | grep -q "error: 403" && echo gitOther=403
    echo "token=$GH_TOKEN"
    echo "mem=$(grep MemTotal /proc/meminfo | tr -s ' ' | cut -d' ' -f2)"
    echo "gh=$(command -v gh)"
    echo "internet=$(curl -s -o /dev/null -w '%{http_connect}' https://example.com)"
    true
    `,
  ).pipe(Effect.map(fields));

  let smallMemory = 0;

  test(
    "start runs a MicroVM whose GitHub requests go through the gateway",
    Effect.gen(function* () {
      yield* call("/start?size=small&ttl=300000");
      const stored = yield* debug;
      expect(stored.microvm?.size).toBe("small");
      const result = yield* probe;
      // The placeholder credential, not a real token, is all the sandbox holds.
      expect(result.token).toBe("alchemy-egress");
      expect(result.gh).toContain("gh");
      // Granted repositories: through the gateway, with its token (5000/h, not 60).
      expect(result).toMatchObject({ statusA: "200", viaA: "1", statusB: "200", viaB: "1" });
      expect(Number(result.limitA)).toBeGreaterThan(60);
      expect(result.gitA).toBe("1");
      // With egress and no `enableInternet`, only granted requests leave:
      // another repository on a routed host and a host without a route are
      // both refused by the proxy, never sent.
      expect(result).toMatchObject({ statusother: "403", viaother: "0" });
      expect(result.gitOther).toBe("403");
      expect(result.internet).toBe("403");
      smallMemory = Number(result.mem);
    }),
    options,
  );

  test(
    "exec runs a command in the running MicroVM: stdin, stdout, stderr, exit code",
    Effect.gen(function* () {
      const script = encodeURIComponent("cat; echo; echo err >&2; id -un; exit 7");
      const result = JSON.parse(yield* call(`/exec?script=${script}`, "hello")) as {
        pid: number;
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      expect(result.pid).toBeGreaterThan(0);
      expect(result.stdout).toBe("hello\nroot\n");
      expect(result.stderr).toBe("err\n");
      expect(result.exitCode).toBe(7);
    }),
    options,
  );

  test(
    "setEgress narrows the running MicroVM without restarting it",
    Effect.gen(function* () {
      const before = yield* debug;
      yield* call("/narrow");
      const result = yield* probe;
      expect(result).toMatchObject({ statusA: "200", viaA: "1" });
      // REPO_B lost its route: straight out with the placeholder.
      expect(result).toMatchObject({ statusB: "401", viaB: "0" });
      const after = yield* debug;
      expect(after.microvm?.id).toBe(before.microvm?.id);
      expect(after.egress).toBe(1);
    }),
    options,
  );

  test(
    "the Durable Object renews grants: requests keep working across expiries",
    Effect.gen(function* () {
      // Running: re-applies with both repositories and a 15-second ttl
      // (renewed every 6 seconds), on the same MicroVM.
      const before = yield* debug;
      yield* call("/start?size=small&ttl=15000");
      const after = yield* debug;
      expect(after.microvm?.id).toBe(before.microvm?.id);
      expect(after.ttl).toBe(15_000);
      // A throttled fetch of REPO_A's pack (far more than 64 KB/s for 40 s,
      // ~6 renewals) alongside 20 requests over 45+ seconds (3 ttls): none
      // is refused or reset, with no retry.
      const shell = yield* exec(
        `(
            sha=$(git ls-remote "https://github.com/${REPO_A}" HEAD | cut -f1)
            printf '0032want %s\\n00000009done\\n' "$sha" | curl -sS --limit-rate 64k --max-time 40 -X POST \\
              -H 'Content-Type: application/x-git-upload-pack-request' --data-binary @- \\
              -D /tmp/pack.h -o /tmp/pack -w 'code=%{http_code}\\nsize=%{size_download}\\nsecs=%{time_total}\\n' \\
              "https://github.com/${REPO_A}.git/git-upload-pack" > /tmp/pack.out
            echo "exit=$?" >> /tmp/pack.out
          ) &
          s=$(date +%s); fails=0
          for i in 1 2 3 4 5 6 7 8 9 10; do
            for r in ${REPO_A} ${REPO_B}; do
              t=$(date +%s); out=$(GIT_CURL_VERBOSE=1 git ls-remote "https://github.com/$r" HEAD 2>&1) || { fails=$((fails + 1)); echo "failed $r after $(( $(date +%s) - t ))s at $(( $(date +%s) - s ))s:" >&2; echo "$out" | grep -E "^(<|>) (HTTP|CONNECT|Connection|Host|content-length)|Connected|error|fatal|Recv|Send|Proxy|SSL" | head -20 >&2; }
            done
            sleep 4
          done
          wait
          echo "fails=$fails"; echo "loop=$(( $(date +%s) - s ))"
          cat /tmp/pack.out
          echo "via=$(grep -ci '^x-alchemy-test-gateway:' /tmp/pack.h)"`,
      );
      const result = fields(shell);
      if (result.fails !== "0")
        console.log(`RENEWAL stdout:\n${shell.stdout}\nRENEWAL stderr:\n${shell.stderr}`);
      expect(result.fails).toBe("0");
      expect(Number(result.loop)).toBeGreaterThanOrEqual(45);
      expect(result).toMatchObject({ code: "200", exit: "28", via: "1" });
      expect(Number(result.secs)).toBeGreaterThanOrEqual(39);
      expect(Number(result.size)).toBeGreaterThan(1_000_000);
    }),
    { ...options, timeout: 240_000 },
  );

  test(
    "each size is its own image: start picks the size's memory",
    Effect.gen(function* () {
      yield* call("/stop");
      expect(JSON.parse(yield* call("/running"))).toBe(false);
      yield* call("/start?size=large&ttl=300000");
      const stored = yield* debug;
      expect(stored.microvm?.size).toBe("large");
      const result = yield* probe;
      expect(result).toMatchObject({ statusA: "200", viaA: "1" });
      expect(smallMemory).toBeGreaterThan(0);
      expect(Number(result.mem)).toBeGreaterThan(smallMemory);
    }),
    options,
  );

  test(
    "stop terminates the MicroVM; the stored egress stays",
    Effect.gen(function* () {
      yield* call("/stop");
      expect(JSON.parse(yield* call("/running"))).toBe(false);
      const stored = yield* debug;
      expect(stored.microvm).toBeUndefined();
      expect(stored.egress).toBe(2);
    }),
    options,
  );
});
