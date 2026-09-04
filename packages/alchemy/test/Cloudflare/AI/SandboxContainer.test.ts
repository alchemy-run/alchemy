/**
 * The `Sandbox` CONTRACT, asserted against the CLOUDFLARE CONTAINER
 * implementation — the same assertions `test/AI/Sandbox.test.ts` makes
 * against `SandboxLocal`, but every operation crosses Worker → Durable
 * Object → container RPC to a real Linux machine.
 *
 * What only this suite can prove: the container boots, the guest serves
 * the contract over RPC, the image carries the tools the toolbox shells
 * out to (`git`, `rg`), workspace containment holds inside the
 * container, and failures arrive as model-visible strings rather than
 * defects.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/sandbox-container/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// image build + push + worker/DO deploy comfortably exceeds the default
// hook budget
const HOOK_TIMEOUT = 900_000;

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

type Envelope<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/**
 * Call one `Sandbox` operation on the deployed container, retrying
 * through fresh-deploy propagation AND container cold start (the first
 * call boots the instance, which can take a while).
 */
const op = <A>(
  url: string,
  operation: string,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<Envelope<A>, never, HttpClient.HttpClient> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ op: operation, args }),
        ),
      ),
    ),
    Effect.flatMap((res) =>
      res.status === 200
        ? (res.json as Effect.Effect<unknown>)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new NotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is NotReady => e instanceof NotReady,
      schedule: Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("5 seconds"),
      ]),
      times: 60,
    }),
    Effect.map((value) => value as Envelope<A>),
    Effect.orDie,
  );

/** Unwrap a successful envelope, failing the test with the error text. */
const value = <A>(envelope: Envelope<A>): A => {
  if (!envelope.ok) {
    throw new Error(`sandbox operation failed: ${envelope.error}`);
  }
  return envelope.value;
};

test(
  "the container boots and serves the contract: exec collects both streams",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const result = value(
      yield* op<{
        success: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
      }>(url, "exec", "echo hello && echo oops 1>&2"),
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr.trim()).toBe("oops");
  }),
  { timeout: 300_000 },
);

test(
  "a non-zero exit is reported, not thrown",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const result = value(
      yield* op<{ success: boolean; exitCode: number }>(url, "exec", "exit 3"),
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  }),
  { timeout: 300_000 },
);

test(
  "file physics round-trip inside the container",
  Effect.gen(function* () {
    const { url } = yield* stack;
    value(yield* op(url, "writeFile", "nested/dir/hello.txt", "hi there\n"));
    expect(
      value(yield* op<string>(url, "readFile", "nested/dir/hello.txt")),
    ).toBe("hi there\n");
    expect(
      value(yield* op<boolean>(url, "exists", "nested/dir/hello.txt")),
    ).toBe(true);

    const entries = value(
      yield* op<ReadonlyArray<{ name: string; type: string }>>(
        url,
        "listFiles",
        "nested",
      ),
    );
    expect(entries).toEqual([{ name: "dir", type: "directory" }]);

    value(yield* op(url, "deleteFile", "nested/dir/hello.txt"));
    expect(
      value(yield* op<boolean>(url, "exists", "nested/dir/hello.txt")),
    ).toBe(false);
  }),
  { timeout: 300_000 },
);

test(
  "the image carries the tools the toolbox shells out to",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // `rg` backs the grep/glob tools; `git` backs checkouts. (FUSE
    // tooling is NOT in the base image — `FUSE.MountTigrisfs` contributes
    // it to images that actually bind a mount.)
    const versions = value(
      yield* op<{ exitCode: number; stdout: string }>(
        url,
        "exec",
        "git --version && rg --version | head -1",
      ),
    );
    expect(versions.exitCode).toBe(0);
    expect(versions.stdout).toContain("git version");
    expect(versions.stdout).toContain("ripgrep");
  }),
  { timeout: 300_000 },
);

test(
  "workspace containment holds INSIDE the container",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // a path escaping /workspace is a model-visible failure, not a read
    const escaped = yield* op<string>(url, "readFile", "../../etc/passwd");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error).toContain("escape");

    const missing = yield* op<string>(url, "readFile", "nope.txt");
    expect(missing.ok).toBe(false);
  }),
  { timeout: 300_000 },
);

test(
  "a real git clone works in the container (network + git + ca-certificates)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const cloned = value(
      yield* op<{ exitCode: number; stdout: string; stderr: string }>(
        url,
        "exec",
        // a tiny public repo; blobless so it stays fast
        "rm -rf probe && git clone --filter=blob:none --depth 1 https://github.com/cloudflare/workers-sdk.git probe 2>&1 | tail -2 && ls probe/package.json",
      ),
    );
    expect(cloned.exitCode).toBe(0);
    expect(cloned.stdout).toContain("probe/package.json");
  }),
  { timeout: 600_000 },
);
