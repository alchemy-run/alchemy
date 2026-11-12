import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "alchemy-test";

const fixture = fileURLToPath(new URL("./fixtures/bun-body-limit.ts", import.meta.url));

// The fixture runs on the same Bun as the test runner, so `Bun.version` below
// describes the server under test.
const bunBinary = typeof Bun === "undefined" ? "bun" : process.execPath;

// Bun enforces `maxRequestBodySize` on chunked bodies (no `Content-Length`)
// only from 1.4.0. Earlier versions enforce it on bodies that declare their
// length, so the chunked cases run only where Bun can refuse them.
const enforcesChunkedLimit =
  typeof Bun !== "undefined" && Bun.semver.order(Bun.version, "1.4.0") >= 0;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/** Runs the fixture under Bun, calls `use` with its base URL, then kills it. */
const withServer = async (env: Record<string, string>, use: (baseUrl: string) => Promise<void>) => {
  const port = await freePort();
  const child = spawn(bunBinary, [fixture], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`fixture exited early: ${code}`)));
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("body-limit ready")) resolve();
      });
    });
    await use(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
  }
};

/** A body streamed without a `Content-Length`, so it is sent chunked. */
const chunkedBody = (bytes: number) => {
  const chunk = new Uint8Array(1024).fill(97);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  });
};

/** Posts a body of `bytes` bytes with a `Content-Length` header. */
const postSized = (baseUrl: string, bytes: number) =>
  fetch(baseUrl, { method: "POST", body: new Uint8Array(bytes).fill(97) });

/** Posts a chunked body of `bytes` bytes. */
const post = (baseUrl: string, bytes: number) =>
  fetch(baseUrl, {
    method: "POST",
    body: chunkedBody(bytes),
    // @ts-expect-error `duplex` is required by fetch for streaming bodies but missing from the DOM types.
    duplex: "half",
  });

describe("BunHttpServer request body limit", { tags: ["unit", "local"] }, () => {
  test(
    "refuses an oversized body with Content-Length with 413 when MAX_REQUEST_BODY_SIZE is set",
    async () => {
      await withServer({ MAX_REQUEST_BODY_SIZE: "4096" }, async (url) => {
        expect((await postSized(url, 64 * 1024)).status).toBe(413);
        // Control: a body under the limit is still served.
        const ok = await postSized(url, 1024);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("1024");
      });
    },
    { timeout: 30_000 },
  );

  test(
    "refuses an oversized body with Content-Length with 413 when maxRequestBodySize is passed",
    async () => {
      await withServer({ BODY_LIMIT_OPTION: "4096" }, async (url) => {
        expect((await postSized(url, 64 * 1024)).status).toBe(413);
      });
    },
    { timeout: 30_000 },
  );

  test.runIf(enforcesChunkedLimit)(
    "refuses an oversized chunked body with 413 when MAX_REQUEST_BODY_SIZE is set",
    async () => {
      await withServer({ MAX_REQUEST_BODY_SIZE: "4096" }, async (url) => {
        expect((await post(url, 64 * 1024)).status).toBe(413);
        // Control: a body under the limit is still served.
        const ok = await post(url, 1024);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("1024");
      });
    },
    { timeout: 30_000 },
  );

  test.runIf(enforcesChunkedLimit)(
    "refuses an oversized chunked body with 413 when maxRequestBodySize is passed",
    async () => {
      await withServer({ BODY_LIMIT_OPTION: "4096" }, async (url) => {
        expect((await post(url, 64 * 1024)).status).toBe(413);
      });
    },
    { timeout: 30_000 },
  );

  test(
    "accepts a large chunked body when no limit is set",
    async () => {
      await withServer({}, async (url) => {
        const res = await post(url, 64 * 1024);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(String(64 * 1024));
      });
    },
    { timeout: 30_000 },
  );
});
