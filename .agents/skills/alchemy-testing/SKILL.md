---
name: alchemy-testing
description: Build and run Alchemy tests and Effect-native fixtures.
---

# Alchemy Testing

## When to use

Load before writing fixtures, running tests, debugging hangs, cleaning leaked resources, or selecting build gates.

# Test Fixtures for Effect-Native Workers / Functions

To test runtime behavior of an Effect-native Worker, Workflow, Lambda, etc., write a **fixture** that defines the Worker/Function with the bindings under test and exposes one HTTP route per behavior, then write a **test** that deploys the fixture once via `beforeAll` and drives it over HTTP.

## File system layout

Put fixtures in a `fixtures/` directory next to the test file. Each test suite owns its own fixtures — never reach across suites:

```sh
packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts
packages/alchemy/test/{Cloud}/{Service}/fixtures/{worker|workflow|handler}.ts
```

## Fixture shape

Resolve the bindings, expose one route per behavior, default-export the class so the test can deploy it directly:

```ts
// fixtures/worker.ts
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Gateway } from "./gateway.ts";

export default class TestWorker extends Cloudflare.Worker<TestWorker>()(
  "TestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/url")) {
          const url = yield* aiGateway.getUrl().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ url });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.AI.QueryGatewayBinding)),
) {}
```

## Test shape

Compose a `Stack` that deploys the fixture, share one deploy across the file with `beforeAll`/`afterAll`, drive it via `HttpClient`, and retry the first request through edge propagation:

```ts
// Service.test.ts
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "ServiceTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* TestWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker exercises the binding",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.get(`${url}/url`).pipe(
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 10 }),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { url: string };
    expect(body.url).toContain("gateway.ai.cloudflare.com");
  }),
  { timeout: 180_000 },
);
```

Notes:

- `Test.make({ providers: Cloudflare.providers() })` gives you `test`, `beforeAll`, `afterAll`, `deploy`, `destroy`.
- `beforeAll(deploy(Stack))` returns a handle (`stack` above) that every `test` body can `yield*` to get the stack outputs.
- `afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack))` is the standard cleanup — set `NO_DESTROY=1` locally to keep the deployment around between runs while iterating.
- Always retry the first request (`Schedule.exponential("500 millis")`) — fresh workers.dev URLs and Lambda function URLs take a few seconds to start serving 200s.
- For POST: use `client.post(url)` for empty bodies, or `HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)))` for typed bodies.
- **Never use `while (Date.now() < deadline)` loops to poll** for an async side effect (a workflow status, a cron fire, a queue drain, eventual-consistency read, etc.). Use `Effect.repeat` with a `Schedule` and an `until` predicate so the polling participates in the Effect runtime — tracing, interruption, and error propagation work correctly, and the intent is declarative. Cap iterations with `times: N` (or a bounded schedule) so the test fails fast instead of running until the test timeout:

  ```ts
  // good — declarative, bounded, interruption-safe
  const value = yield* fetchValue.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (v) => v.ready,
      times: 36,
    }),
  );

  // bad — opaque loop, ignores interruption, leaks into the test timeout
  let value: Value | undefined;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    value = yield* fetchValue;
    if (value.ready) break;
    yield* Effect.sleep("5 seconds");
  }
  ```

  See [CronEventSource.test.ts](../../../packages/alchemy/test/Cloudflare/Workers/CronEventSource.test.ts) for a real-world example (polling a DO via the worker's `/times` route until the cron handler fires).

## Reference implementations

- Cloudflare.AI.Gateway — [worker fixture](../../../packages/alchemy/test/Cloudflare/AI/fixtures/TestWorker.ts) + [test](../../../packages/alchemy/test/Cloudflare/AI/Gateway.test.ts) (the deploy+fetch case lives at the bottom of the file)
- Cloudflare D1Connection — [stack fixture](../../../packages/alchemy/test/Cloudflare/D1/fixtures/stack.ts) + [test](../../../packages/alchemy/test/Cloudflare/D1/D1Binding.test.ts)
- Cloudflare Workflow — [workflow fixture](../../../packages/alchemy/test/Cloudflare/Workers/fixtures/workflow/test-workflow.ts) + [worker fixture](../../../packages/alchemy/test/Cloudflare/Workers/fixtures/workflow/workflow-worker.ts) + [test](../../../packages/alchemy/test/Cloudflare/Workers/Workflow.test.ts)
- Cloudflare Cron Trigger — [worker + DO fixture](../../../packages/alchemy/test/Cloudflare/Workers/fixtures/cron/cron-worker.ts) + [test](../../../packages/alchemy/test/Cloudflare/Workers/CronEventSource.test.ts) (cron handler writes to a DO; test polls a fetch route with `Effect.repeat` until the scheduled handler fires)
- Cloudflare Images — [effect fixture](../../../packages/alchemy/test/Cloudflare/Images/fixtures/effect-worker.ts) + [async fixture](../../../packages/alchemy/test/Cloudflare/Images/fixtures/async-worker.ts) + [test](../../../packages/alchemy/test/Cloudflare/Images/Images.test.ts)
- AWS Lambda (DynamoDB bindings) — [Lambda fixture](../../../packages/alchemy/test/AWS/DynamoDB/handler.ts) + [test](../../../packages/alchemy/test/AWS/DynamoDB/Bindings.test.ts) (one `describe("<BindingName>")` per binding, all driving the same deployed Lambda)


# Build and Type Checking

Always run type checking before committing changes:

```bash
pnpm exec tsc -b
```

This runs the TypeScript compiler in build mode, which checks all projects in the workspace (including the distilled packages, which are project references). This is critical because CI will fail if there are type errors.

## Running tests

`packages/alchemy/test` runs on **alchemy-test** (`packages/alchemy-test`), our own single-process, Effect-native test runner. The CLI is vitest/bun-test compatible: positional paths (files or directories) and `-t` work the same way.

There is exactly ONE entry point: `pnpm test <options>`. It works identically from the repo root and from `packages/alchemy` (the root script just cds into `packages/alchemy`); suite paths are always relative to `packages/alchemy`. Compose the flags you need — there are no per-variant package scripts. NOTE: `pnpm test`, not `bun test` — the latter invokes bun's own built-in test runner.

```bash
# a suite, against the real cloud
pnpm test test/Cloudflare/{Service}/{Resource}.test.ts --profile testing

# a directory, filtered by test name
pnpm test test/Cloudflare/Workers -t "cron" --profile testing

# positional args that aren't real paths are file-name substring filters
pnpm test Bucket --profile testing   # every *Bucket* test file

# skip the slow tests (replaces the old FAST=1 env prefix)
pnpm test --fast --profile testing

# interactive TUI (humans only — never in an agent shell)
pnpm test --tui
```

(`examples/` still use plain `bun test`.)

### Cleaning leaked test resources

If an interrupted live-cloud test leaves resources behind, do **not** add
test-specific API cleanup helpers, adoption workarounds, or alternate names to
make the test pass. Clean the testing account with the account-wide teardown
command, then rerun the failing test:

```bash
pnpm nuke
pnpm clear:state --profile testing
```

Lifecycle tests should continue to validate normal stack ownership and cleanup;
they must not silently adopt or directly delete leaked resources from earlier
runs.

Additional flags beyond vitest:

| Flag              | Default | Purpose                                                       |
| ----------------- | ------- | ------------------------------------------------------------- |
| `-t <regex>`      | —       | Test-name pattern (regex, like bun/vitest) tested against the full nested title (`file > describes > name`), so any fragment matches regardless of nesting. An invalid regex degrades to a literal substring instead of erroring. Remember to escape regex metacharacters when filtering literally: `-t "create \(default\)"` |
| `--profile <name>` | —      | Sets `ALCHEMY_PROFILE` before any test module is imported. Use `--profile testing` for live-cloud suites instead of an `ALCHEMY_PROFILE=testing` env prefix |
| `--fast`          | off     | Sets `FAST=1` before imports — suites `skipIf(process.env.FAST)` their slow tests (long-provisioning resources, smoke tests). Replaces the `FAST=1` env prefix |
| `--timeout <ms>`  | 120000  | Default per-test timeout                                      |
| `--retry <n>`     | 2       | Re-runs of a failing test body (use `--retry 0` when debugging) |
| `--concurrency <n\|unbounded>` | 32 | Files running concurrently (one bun process, no forks). Bounded by default — unbounded saturates the event loop on large suites and produces spurious 0ms `beforeAll` timeouts |
| `--sequential`    | off     | Run tests within each file sequentially                       |
| `--tui`           | off     | Opt-in interactive TUI (default is line-per-test output)      |

Output behavior (plain mode, the default):

- The collection phase (importing every test file, ~45s for the full suite) reports `collecting N/TOTAL test files (elapsed) <current file>` — repainted in place on a TTY, printed every 5s otherwise. A run that appears stuck before any test starts is almost always just collecting; if it really is stuck, the line names the file whose import hangs.
- One line per test as it finishes, prefixed with a `[done/total]` progress counter so the remaining count is visible; a **failing test prints its error and captured output inline** immediately.
- Passing tests' output is swallowed on the console — but **every** test's output (passes included) is streamed to a per-run log at **`.alchemy/log/test/{timestamp}-pid{pid}.log`** (relative to the cwd), so concurrent runs in different terminals never trample each other. The absolute path (with line/KB counts) is printed at the end of every run (`Full log: …`) — read that file when you need the complete record, e.g. a passing test's deploy output or a hang's partial log. The file is appended live, so it's readable mid-run; logs older than a week are pruned automatically (by stat mtime).
- If nothing finishes for 10s, the runner prints the list of currently-running tests with elapsed times — the first place to look when a run seems hung.
- Exit code is non-zero if any test failed.

Runner semantics to know:

- Everything runs in ONE bun process: files run concurrently (respecting `describe.sequential`), imports of all test files happen up-front (they must be lazy and pure — registration only, no top-level side effects beyond `Test.make`/`describe`/`test`).
- Tests that mutate process-global state (e.g. `process.env.PATH`) must pass `{ exclusive: true }` in the test options to take the whole-process write lock.
- The harness (`alchemy-test` package) provides `describe`, `it`/`test` (incl. `it.effect`/`it.live`), hooks, `layer`, `expect`, and `assert` — the codemod `scripts/codemod-alchemy-test.ts` migrates vitest imports and is idempotent.
- The runner runs in plain bun, so distilled resolves from `src/*.ts` via the `bun` export condition — a regenerated service is test-visible immediately, no `lib/` rebuild required.


## Build Commands

| Command           | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `pnpm exec tsc -b`      | Type check all projects (always run before committing)                                       |
| `pnpm build`   | Clean, type check, and build the alchemy package                                             |
| `pnpm build:clean` | Full clean rebuild: cleans all artifacts, reinstalls dependencies, builds, and downloads env |

Use `pnpm build:clean` when you encounter stale build artifacts or dependency issues. It runs:

1. `pnpm clean .` - Removes all untracked files except .env
2. `pnpm install` - Reinstalls dependencies
3. `pnpm build` - Builds the project
4. `pnpm download:env` - Downloads environment files
