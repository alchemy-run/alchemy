/**
 * Local vinext production build + Node serve entry. No Fly account: this is `vinext build` plus the generated `serve-node.mjs`, the same program Fly.Website.Vinext deploys.
 */
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { makeVinextServeEntrySource } from "@alchemy.run/frontend-frameworks/vinext/node";

const root = path.resolve(import.meta.dirname, "..");
const servePath = path.join(root, "dist", "server", "serve-node.mjs");
const GREETING = "Hello from vinext on Fly!";

const pickPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });

const run = (args: string[], env: Record<string, string | undefined> = {}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("node", args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}\n${output.slice(-4000)}`));
    });
    child.once("error", reject);
  });

let server: ReturnType<typeof spawn> | undefined;

afterAll(() => {
  if (server?.pid) {
    try {
      server.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
});

test(
  "vinext build serves hello world, API route, health, and public assets",
  async () => {
    const cli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
    await run([cli, "build"], { NODE_ENV: "production" });

    fs.mkdirSync(path.dirname(servePath), { recursive: true });
    fs.writeFileSync(servePath, makeVinextServeEntrySource());

    const port = await pickPort();
    server = spawn("node", [servePath], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        GREETING,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    server.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    server.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });

    const base = `http://127.0.0.1:${port}`;
    let last: Response | undefined;
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) {
        throw new Error(`server exited:\n${output.slice(-4000)}`);
      }
      try {
        last = await fetch(`${base}/health`);
        if (last.ok) break;
      } catch {
        // not listening yet
      }
      await Bun.sleep(250);
    }
    expect(last?.status).toBe(200);
    expect(await last!.text()).toBe("ok");

    const home = await fetch(base);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(GREETING);
    expect(html).toContain("vinext on Fly");
    expect(html).toContain("text-3xl");

    const api = await fetch(`${base}/api/hello`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ hello: "world" });

    const isr = await fetch(`${base}/isr`);
    expect(isr.status).toBe(200);
    expect(await isr.text()).toContain("ISR");

    const robots = await fetch(`${base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("User-agent:");
  },
  { timeout: 120_000 },
);
