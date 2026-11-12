import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import MountContainerLive from "./fixtures/mount-container.ts";
import { Dataset, Preview, SeedBase } from "./fixtures/resources.ts";
import ArchilWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Archil.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ArchilBindingsStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    yield* SeedBase;
    const preview = yield* Preview;
    const dataset = yield* Dataset;
    const worker = yield* ArchilWorker;
    return {
      url: worker.url.as<string>(),
      preview: preview.sandboxId,
      dataset: dataset.diskId,
      stage: yield* Alchemy.Stage,
    };
  }).pipe(Effect.provide(MountContainerLive)),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const call = (path: string, init?: { method?: "PUT"; body?: string }) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const request =
      init?.method === "PUT"
        ? HttpClientRequest.put(`${url}${path}`).pipe(HttpClientRequest.bodyText(init.body ?? ""))
        : HttpClientRequest.get(`${url}${path}`);
    return yield* client.execute(request).pipe(
      // Keep the Worker's error text (its Cause) in the failure.
      Effect.flatMap((res) =>
        res.status >= 200 && res.status < 300
          ? Effect.succeed(res)
          : Effect.flatMap(res.text, (text) =>
              Effect.fail(new RouteFailed({ path, status: res.status, text })),
            ),
      ),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
    );
  });

const json = <A>(path: string) =>
  call(path).pipe(Effect.flatMap((r) => r.json as Effect.Effect<A, any>));
const text = (path: string) => call(path).pipe(Effect.flatMap((r) => r.text));

class RouteFailed extends Data.TaggedError("RouteFailed")<{
  readonly path: string;
  readonly status: number;
  readonly text: string;
}> {
  override get message() {
    return `${this.path} answered ${this.status}: ${this.text}`;
  }
}
class MountRouteFailed extends Data.TaggedError("MountRouteFailed")<{ readonly text: string }> {}
class ProxyNotReady extends Data.TaggedError("ProxyNotReady")<{ readonly status: number }> {}

const tags = ["provider:archil", "provider:cloudflare", "provider:cloudflare:worker", "live"];

describe("WriteDisk + ReadDisk", () => {
  test(
    "a file written as an object is read back, listed, and shared",
    Effect.gen(function* () {
      yield* call("/put?key=hello.txt", { method: "PUT", body: "hello archil" });
      expect(yield* text("/get?key=hello.txt")).toBe("hello archil");
      expect(yield* json<string[]>("/list")).toContain("hello.txt");
      const { url } = yield* json<{ url: string }>("/share?key=hello.txt");
      const client = yield* HttpClient.HttpClient;
      const shared = yield* client.get(url).pipe(Effect.flatMap((r) => r.text));
      expect(shared).toBe("hello archil");
    }),
    { tags, timeout: 180_000 },
  );
});

describe("Least privilege", () => {
  test.provider(
    "object bindings hold S3 users on the bound disk only, read-only for ReadDisk",
    () =>
      Effect.gen(function* () {
        const { dataset } = yield* stack;
        const { data } = yield* archil.getDisk({ id: dataset });
        const s3 = (data.authorizedUsers ?? []).filter((u) => u.type === "s3");
        // ReadDisk → one read-only user; WriteDisk and ReadWriteDisk share one read-write user.
        expect(s3.map((u) => u.readOnly ?? false).sort()).toEqual([false, true]);
        // MountDisk(Dataset, { mode: "read-only" }) → the Container's one read-only token user.
        const readOnlyTokens = (data.authorizedUsers ?? []).filter(
          (u) => u.type === "token" && u.readOnly === true,
        );
        expect(readOnlyTokens.length).toBe(1);
      }),
    { tags, timeout: 60_000 },
  );
});

describe("WriteDisk.upload + ReadDisk.getStream", () => {
  test(
    "a 12 MiB file uploads in parts and streams back whole",
    Effect.gen(function* () {
      const body = yield* json<{ etag: string; size: number; streamed: number }>(
        "/upload?key=big.bin",
      );
      expect(body.size).toBe(12 * 1024 * 1024);
      expect(body.streamed).toBe(12 * 1024 * 1024);
      expect(body.etag).toMatch(/-2"?$/);
    }),
    { tags, timeout: 180_000 },
  );
});

describe("delegations", () => {
  test(
    "a mounted writer's delegation is listed and revoked",
    Effect.gen(function* () {
      const body = yield* json<{ held: number; after: number; dataset: boolean }>(
        "/delegations?name=delegated",
      );
      expect(body.held).toBeGreaterThan(0);
      expect(body.after).toBe(0);
      expect(body.dataset).toBe(true);
    }),
    { tags, timeout: 180_000 },
  );
});

describe("ConnectSandbox.listPortTokens", () => {
  test(
    "a created port token is listed until it's revoked",
    Effect.gen(function* () {
      const body = yield* json<{ id: string; listed: string[]; after: string[] }>("/port-tokens");
      expect(body.listed).toContain(body.id);
      expect(body.after).not.toContain(body.id);
    }),
    { tags, timeout: 180_000 },
  );
});

describe("ReadWriteDisk", () => {
  test(
    "append, read, and delete in one client",
    Effect.gen(function* () {
      const body = yield* json<{ text: string; after: unknown }>("/roundtrip?key=log.txt");
      expect(body.text).toBe("ab");
      expect(body.after).toBeNull();
    }),
    { tags, timeout: 180_000 },
  );
});

describe("ExecDisk", () => {
  test(
    "exec sees the files on the disk, and grep finds them",
    Effect.gen(function* () {
      yield* call("/put?key=grep/needle.txt", { method: "PUT", body: "find the NEEDLE here" });
      const result = yield* json<{ exitCode: number; stdout: string }>(
        `/exec?command=${encodeURIComponent("cat /mnt/archil/grep/needle.txt")}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("NEEDLE");
      const grep = yield* json<{ matches: Array<{ file: string }> }>("/grep?pattern=NEEDLE");
      expect(grep.matches.map((m) => m.file).join(",")).toContain("needle.txt");
    }),
    { tags, timeout: 180_000 },
  );
});

describe("ExecDisks + CreateDisk", () => {
  test(
    "one exec copies between two disks created at run time",
    Effect.gen(function* () {
      const result = yield* json<{ exitCode: number; stdout: string }>("/exec-many?user=exec-user");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("copied");
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateDisk", () => {
  test(
    "disks are created by name, stamped with the binding's prefix, and deleted",
    Effect.gen(function* () {
      const body = yield* json<{ stdout: string; listed: string[]; name: string; gone: boolean }>(
        "/disk?name=user-1&delete=1",
      );
      expect(body.stdout.trim()).toBe("user-1");
      expect(body.name.endsWith("-user-1")).toBe(true);
      expect(body.listed).toContain(body.name);
      expect(body.gone).toBe(true);
    }),
    { tags, timeout: 180_000 },
  );
});

/** The owner prefix `runtimePrefix` derives, recomputed here from the three tags. */
const ownerPrefix = (tags: Record<"alchemy::stack" | "alchemy::stage" | "alchemy::id", string>) => {
  const owner = `${tags["alchemy::stack"]}/${tags["alchemy::stage"]}/${tags["alchemy::id"]}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < owner.length; i++) {
    hash ^= owner.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const readable = tags["alchemy::id"].toLowerCase().slice(0, 14);
  return `alc-${readable}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

describe("run-time objects", () => {
  test.provider(
    "disks and sandboxes created at run time carry the stack, stage and binding",
    () =>
      Effect.gen(function* () {
        const { stage } = yield* stack;
        const body = yield* json<{
          disk: { id: string; name: string; prefix: string };
          sandbox: { id: string; name: string; prefix: string };
        }>("/tagged?name=tagged");
        const diskPrefix = ownerPrefix({
          "alchemy::stack": "ArchilBindingsStack",
          "alchemy::stage": stage,
          "alchemy::id": "ArchilWorkerDisks",
        });
        const sandboxPrefix = ownerPrefix({
          "alchemy::stack": "ArchilBindingsStack",
          "alchemy::stage": stage,
          "alchemy::id": "ArchilWorkerSandboxes",
        });
        expect(body.disk.prefix).toBe(diskPrefix);
        expect(body.sandbox.prefix).toBe(sandboxPrefix);

        // Out of band: Archil lists them under the tagged names.
        const disks = yield* archil.listDisks({});
        const disk = (disks.data as Array<{ id: string; name: string }>).find(
          (d) => d.id === body.disk.id,
        );
        expect(disk?.name).toBe(`${diskPrefix}-tagged`);
        const { data: sandbox } = yield* archil.getSandbox({ sid: body.sandbox.id });
        expect(sandbox.name).toBe(`${sandboxPrefix}-tagged`);

        // Destroying the stack leaves them, so the test deletes them itself.
        yield* Archil.deleteSandbox(body.sandbox.id);
        yield* Archil.deleteDisk(body.disk.id);
        const after = (yield* archil.listDisks({})).data as Array<{ id: string; status: string }>;
        expect(after.some((d) => d.id === body.disk.id && d.status !== "deleted")).toBe(false);
      }),
    { tags, timeout: 300_000 },
  );
});

describe("BranchDisk", () => {
  test(
    "a branch forks from the seeded checkpoint",
    Effect.gen(function* () {
      const body = yield* json<{ branch: Archil.BranchAttributes; all: string[] }>(
        "/branch?name=session-1",
      );
      expect(body.branch.fromCheckpoint).toBe("base");
      expect(body.all).toContain("session-1");
    }),
    { tags, timeout: 180_000 },
  );
});

/**
 * Many requests create one name at once. Archil fails every create but the
 * first (409 `conflict` on branches, `sandbox_name_conflict` on sandboxes),
 * and each binding has to converge on the object the winner made.
 */
const race = <A>(path: string) =>
  Effect.gen(function* () {
    // Warm the Worker with a retried call, then race without retries: a
    // retry would find the winner's object and hide a create that failed.
    yield* call("/delete-disk?name=warm-up");
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return yield* Effect.all(
      Array.from({ length: 6 }, () =>
        client.get(`${url}${path}`).pipe(Effect.flatMap((r) => r.json as Effect.Effect<A, any>)),
      ),
      { concurrency: "unbounded" },
    );
  });

describe("concurrent creates", () => {
  test(
    "BranchDisk: concurrent creates of one branch all return it",
    Effect.gen(function* () {
      const all = yield* race<{ branch: Archil.BranchAttributes }>("/branch?name=session-race");
      expect(new Set(all.map((b) => b.branch.filesystemId)).size).toBe(1);
    }),
    { tags, timeout: 180_000 },
  );
  test(
    "CreateDisk: concurrent creates of one disk all return it",
    Effect.gen(function* () {
      const all = yield* race<{ id: string }>("/create-disk?name=race-1");
      yield* call("/delete-disk?name=race-1");
      expect(new Set(all.map((d) => d.id)).size).toBe(1);
    }),
    { tags, timeout: 180_000 },
  );
  test(
    "CreateSandbox: concurrent creates of one sandbox all return it",
    Effect.gen(function* () {
      const all = yield* race<{ id: string }>("/create-sandbox?name=race-1");
      yield* call("/delete-sandbox?name=race-1");
      expect(new Set(all.map((x) => x.id)).size).toBe(1);
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateSandbox on a paused sandbox", () => {
  test(
    "exec resumes a paused sandbox and runs",
    Effect.gen(function* () {
      const body = yield* json<{ paused: string; stdout: string }>("/paused?name=paused-1");
      expect(body).toEqual({ paused: "paused", stdout: "awake" });
    }),
    { tags, timeout: 240_000 },
  );
});

describe("CreateImage", () => {
  test(
    "an image builds at run time",
    Effect.gen(function* () {
      const image = yield* json<Archil.ImageAttributes>("/image");
      expect(image.imageId).toMatch(/^[0-9a-f]{64}$/);
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateSandbox", () => {
  test(
    "a sandbox runs commands, a background process and a terminal, forks with its files, and is deleted",
    Effect.gen(function* () {
      const body = yield* json<{
        stdout: string;
        text: string;
        listed: string[];
        stat: { type: string; size: number };
        removed: number;
        piped: string;
        failed: number;
        started: { output: string; exitCode: number };
        size: string;
        fork: string;
      }>("/sandbox?name=task-1");
      expect(body).toEqual({
        stdout: "hi from worker",
        text: "hi from worker",
        listed: ["directory:/tmp/tree/sub", "file:/tmp/tree/a.txt"],
        stat: { type: "file", size: 3 },
        removed: 1,
        piped: "PIPED IN",
        failed: 3,
        started: { output: "started", exitCode: 0 },
        size: "30 100",
        fork: "hi from worker",
      });
    }),
    { tags, timeout: 300_000 },
  );
});

describe("ConnectSandbox", () => {
  test(
    "the deploy-time sandbox runs commands and exposes ports",
    Effect.gen(function* () {
      const body = yield* json<{ stdout: string; hostname: string }>("/preview");
      expect(body.stdout).toBe("preview-ok");
      expect(body.hostname.length).toBeGreaterThan(0);
    }),
    { tags, timeout: 300_000 },
  );

  test(
    "getTcpPort fetch: client request",
    Effect.gen(function* () {
      const body = yield* json<{
        status: number;
        echoHeader: string | null;
        contentType: string | null;
        body: { method: string; url: string; header: string | null; body: string };
        port: { port: number; hostname: string; url: string };
      }>("/port-client");
      // What the server in the sandbox received.
      expect(body.body).toEqual({
        method: "POST",
        url: "/echo/client?x=1&y=two",
        header: "client-header",
        body: "client-body",
      });
      // What came back to the caller.
      expect(body.status).toBe(201);
      expect(body.echoHeader).toBe("archil");
      expect(body.contentType).toBe("application/json");
      expect(body.port.port).toBe(8082);
      expect(body.port.url).toBe(`https://${body.port.hostname}`);
      expect(body.port.hostname).toContain("archil.app");
    }),
    { tags, timeout: 300_000 },
  );

  test(
    "getTcpPort fetch: proxies a server request",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const res = yield* client
        .execute(
          HttpClientRequest.post(`${url}/port-proxy/echo?x=1&y=two`).pipe(
            HttpClientRequest.setHeader("x-test", "proxy-header"),
            HttpClientRequest.bodyText("proxied-body"),
          ),
        )
        .pipe(
          Effect.filterOrFail(
            (r) => r.status === 201,
            (r) => new ProxyNotReady({ status: r.status }),
          ),
          Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
        );
      // What came back through the Worker.
      expect(res.status).toBe(201);
      expect(res.headers["x-echo"]).toBe("archil");
      expect(res.headers["content-type"]).toBe("application/json");
      // What the server in the sandbox received.
      expect(yield* res.json).toEqual({
        method: "POST",
        url: "/port-proxy/echo?x=1&y=two",
        header: "proxy-header",
        body: "proxied-body",
      });
    }),
    { tags, timeout: 300_000 },
  );
});

describe("MountDisk", () => {
  test(
    "a Container mounts the disk with its own disk user and reads a file",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* call("/put?key=mounted.txt", { method: "PUT", body: "through fuse" });
      const client = yield* HttpClient.HttpClient;
      // The container cold-starts; keep its error text so a failed mount
      // shows the Archil client's stderr instead of a bare 500.
      const body = yield* client.get(`${url}/mount?key=mounted.txt`).pipe(
        Effect.flatMap((res) =>
          Effect.flatMap(res.text, (text) =>
            res.status === 200 ? Effect.succeed(text) : Effect.fail(new MountRouteFailed({ text })),
          ),
        ),
        // A cold start can hold a request open; give up on it and ask again
        // rather than wait out the whole test.
        Effect.timeout("30 seconds"),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 7 }),
        Effect.catchTag("MountRouteFailed", (e) => Effect.succeed(e.text)),
      );
      expect(body).toBe("through fuse");
    }),
    { tags: [...tags, "provider:cloudflare:container"], timeout: 300_000 },
  );
});
