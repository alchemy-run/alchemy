import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secret from "@distilled.cloud/modal/secret";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ModalBindingsFunction from "./fixtures/bindings-function.ts";
import ModalBindingsWorker from "./fixtures/bindings-worker.ts";
import { Token } from "./fixtures/resources.ts";
import { hostIdentity } from "./hostIdentity.ts";

const providers = Layer.mergeAll(
  Modal.providers(),
  AWS.providers(),
  Cloudflare.providers(),
  hostIdentity,
);
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ModalBindingsStack",
  { providers, state: AWS.state() },
  Effect.gen(function* () {
    const token = yield* Token;
    const fn = yield* ModalBindingsFunction;
    const worker = yield* ModalBindingsWorker;
    return {
      urls: { lambda: fn.functionUrl.as<string>(), worker: worker.url.as<string>() },
      secretId: token.secretId,
    };
  }),
);

// The fixture deploys a Lambda, a Worker and Modal runtimes; next to the rest
// of the Modal suite that takes longer than the default hook timeout.
const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

/**
 * The hosts each case runs on. A Worker reaches Modal's control plane over a
 * `cloudflare:sockets` socket, but not a sandbox's task command router,
 * which speaks only HTTP/2 (exec, file access and snapshots).
 */
const hosts = [
  { name: "a Lambda function", key: "lambda", router: true, tag: "provider:aws" },
  { name: "a Cloudflare Worker", key: "worker", router: false, tag: "provider:cloudflare" },
] as const;
type Host = (typeof hosts)[number];

const get = <A>(host: Host, path: string) =>
  Effect.gen(function* () {
    const url = (yield* stack).urls[host.key];
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* res.json) as A;
  });

const tags = (host: Host, kind: string) => [
  "provider:modal",
  `provider:modal:${kind}`,
  host.tag,
  "live",
];

for (const host of hosts) {
  // Exec, sandbox files and snapshots go through the task command router.
  const routerTest = host.router ? test : test.skip;

  describe(`from ${host.name}`, () => {
    describe("ReadVolume / WriteVolume / ReadWriteVolume", () => {
      test(
        "write, read, copy, list and remove volume files",
        Effect.gen(function* () {
          const body = yield* get<{ text: string; files: string[] }>(
            host,
            `/volume?key=v-${host.key}`,
          );
          expect(body.text).toBe(`hello v-${host.key}`);
          expect(body.files).toContain(`v-${host.key}.txt`);
          expect(body.files).toContain(`v-${host.key}-copy.txt`);
        }),
        { tags: tags(host, "volume"), timeout: 180_000 },
      );
    });

    describe("ReadDict / WriteDict / ReadWriteDict", () => {
      test(
        "put, get, contains and pop",
        Effect.gen(function* () {
          const body = yield* get<Record<string, unknown>>(host, `/dict?key=d-${host.key}`);
          expect(body).toEqual({ value: { n: 1 }, contains: true, popped: { n: 1 }, after: false });
        }),
        { tags: tags(host, "dict"), timeout: 180_000 },
      );
    });

    describe("ReadQueue / WriteQueue / ReadWriteQueue", () => {
      test(
        "put into a partition and take from it",
        Effect.gen(function* () {
          const body = yield* get<{ len: number; taken: unknown[] }>(
            host,
            `/queue?key=q-${host.key}`,
          );
          expect(body.len).toBe(2);
          expect(body.taken).toEqual([{ i: 1 }, { i: 2 }]);
        }),
        { tags: tags(host, "queue"), timeout: 180_000 },
      );
    });

    describe("WriteSecret", () => {
      test.provider(
        "rotate a secret",
        () =>
          Effect.gen(function* () {
            yield* get(host, `/secret?key=s-${host.key}`);
            const { secretId } = yield* stack;
            const { metadata } = yield* secret.secretGetInfo({ secretId });
            expect(metadata?.keys).toEqual(["TOKEN"]);
          }),
        { tags: tags(host, "secret"), timeout: 180_000 },
      );
    });

    describe("CreateSandbox", () => {
      routerTest(
        "create a sandbox from a bound image and exec in it",
        Effect.gen(function* () {
          const body = yield* get<{ exitCode: number; stdout: string }>(
            host,
            `/sandbox?key=x-${host.key}`,
          );
          expect(body.exitCode).toBe(0);
          expect(body.stdout.trim()).toBe("ready");
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      routerTest(
        "read the output of a sandbox's program",
        Effect.gen(function* () {
          const body = yield* get<{ exitCode: number; logs: string }>(
            host,
            `/sandbox-logs?key=l-${host.key}`,
          );
          expect(body.exitCode).toBe(0);
          expect(body.logs).toBe("from-the-program\n");
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      routerTest(
        "write and read sandbox files and snapshot the filesystem",
        Effect.gen(function* () {
          const body = yield* get<{ read: string; snapshot: string }>(host, "/sandbox-files");
          expect(body.read).toBe("written");
          expect(body.snapshot).toMatch(/^im-/);
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      routerTest(
        "mount a volume handle and a MountVolume reference into a sandbox",
        Effect.gen(function* () {
          const body = yield* get<{
            stdout: string;
            exitCode: number;
            size: number;
            type: string;
          }>(host, `/mount?key=m-${host.key}`);
          expect(body.exitCode).toBe(0);
          expect(body.stdout).toBe(`hello m-${host.key}mounted\n`);
          expect(body.size).toBe(`hello m-${host.key}`.length);
          expect(body.type).toBe("file");
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      routerTest(
        "start a process, stream its output, write its stdin, and open a PTY",
        Effect.gen(function* () {
          const body = yield* get<{
            exitCode: number;
            chunks: Array<{ fd: string; text: string; at: number }>;
            pty: boolean;
          }>(host, "/process");
          expect(body.exitCode).toBe(0);
          const text = (fd: string) =>
            body.chunks
              .filter((c) => c.fd === fd)
              .map((c) => c.text)
              .join("");
          expect(text("stdout")).toBe("one\ngot=hello\n");
          expect(text("stderr")).toBe("two\n");
          // "one" streamed before the command finished, not at exit.
          const one = body.chunks.find((c) => c.text.includes("one"))!;
          const got = body.chunks.find((c) => c.text.includes("got="))!;
          expect(got.at - one.at).toBeGreaterThan(1_500);
          expect(body.pty).toBe(true);
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      test(
        "find a sandbox by name",
        Effect.gen(function* () {
          const body = yield* get<{ created: string; found: string }>(
            host,
            `/sandbox-named?key=n-${host.key}`,
          );
          expect(body.found).toBe(body.created);
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      test(
        "report sandbox cost grouped by tag",
        Effect.gen(function* () {
          const body = yield* get<{ groups: number }>(host, "/sandbox-usage");
          expect(body.groups).toBeGreaterThanOrEqual(0);
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );
    });

    describe("CreateSandbox network", () => {
      routerTest(
        "add a secret to matching HTTPS requests without exposing it inside the sandbox",
        Effect.gen(function* () {
          const body = yield* get<{
            injected: boolean;
            rotated: boolean;
            leaked: boolean;
            stderr: string;
          }>(host, `/egress?key=e-${host.key}`);
          expect(body).toMatchObject({ injected: true, rotated: true, leaked: false });
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      routerTest(
        "limit a sandbox to an allow-list of domains, then block and reopen its network while it runs",
        Effect.gen(function* () {
          const body = yield* get<Record<string, boolean>>(host, `/network?key=n-${host.key}`);
          expect(body).toEqual({
            allowed: true,
            unlisted: false,
            blocked: false,
            reopened: true,
          });
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );

      routerTest(
        "give a sandbox an identity token Modal signs",
        Effect.gen(function* () {
          const body = yield* get<{
            issuer: string;
            subject: string;
            sandboxId: string;
            claims: string[];
          }>(host, `/identity?key=t-${host.key}`);
          expect(body.issuer).toBe("https://oidc.modal.com");
          expect(body.subject).toContain("modal:workspace_id:");
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );
    });

    describe("CreateSandbox persistent", () => {
      // Persistent sandboxes are in beta; set MODAL_TEST_PERSISTENT_SANDBOX=1
      // on an entitled workspace (PersistentSandbox.test.ts probes the
      // rejection).
      (host.router ? test.skipIf(!process.env.MODAL_TEST_PERSISTENT_SANDBOX) : test.skip)(
        "create a persistent sandbox and reach its session by id",
        Effect.gen(function* () {
          const body = yield* get<{ read: string }>(host, `/sandbox-persistent?key=p-${host.key}`);
          expect(body.read).toBe(`kept p-${host.key}`);
        }),
        { tags: tags(host, "sandbox"), timeout: 300_000 },
      );
    });

    describe("CreateImage", () => {
      test(
        "build an image with a context file at runtime",
        Effect.gen(function* () {
          const body = yield* get<{
            imageId: string;
            published: string;
            unpublished: string | null;
          }>(host, `/image?key=i-${host.key}`);
          expect(body.imageId).toMatch(/^im-/);
          expect(body.published).toBe(body.imageId);
          expect(body.unpublished).toBeNull();
        }),
        { tags: tags(host, "image"), timeout: 600_000 },
      );
    });

    describe("CreateVolume / CreateDict / CreateQueue / CreateSecret", () => {
      test(
        "get-or-create, list and delete objects by name at runtime",
        Effect.gen(function* () {
          const body = yield* get<{
            listed: Record<string, boolean>;
            keys: string[];
            gone: boolean;
          }>(host, `/open?key=o-${host.key}`);
          expect(body.listed).toEqual({ volumes: true, dicts: true, queues: true, secrets: true });
          expect(body.keys).toEqual(["A"]);
          expect(body.gone).toBe(true);
        }),
        { tags: tags(host, "open"), timeout: 180_000 },
      );
    });
  });
}
