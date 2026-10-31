import * as NodeNet from "node:net";
import * as Portless from "@alchemy.run/portless";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isAlive, readRoutes } from "./fixtures/Processes.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : String(error);

const readPid = (stateDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return Number.parseInt(yield* fs.readFileString(path.join(stateDirectory, "proxy.pid")), 10);
  });

const exists = (stateDirectory: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(stateDirectory, file));
  });

const program = (domain: string) =>
  Effect.gen(function* () {
    return yield* Portless.Proxy("Proxy", { domain });
  });

// Each scenario owns a proxy of its own: a state directory and a free high port.
const reuse = TestProxy.make();
const reused = Test.make({ providers: reuse.providers(), dev: true, stage: "dev_alice" });
reused.afterAll(reuse.stop);

reused.test.provider(
  "Proxy starts the shared proxy once, and later runs find it and reuse it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stateDirectory = yield* reuse.stateDirectory;
      const port = yield* reuse.port;

      const first = yield* stack.deploy(program("proxy-reuse"));
      expect(first).toMatchObject({ domain: "proxy-reuse", port, stateDirectory });
      expect(first.certificateAuthority).toBe(`${stateDirectory}/ca.pem`);
      expect(yield* exists(stateDirectory, "ca.pem")).toBe(true);
      // HTTPS, .localhost only, unprivileged: the settings of the proxy Alchemy starts.
      expect(yield* exists(stateDirectory, "proxy.tls")).toBe(true);
      expect(yield* exists(stateDirectory, "proxy.unprivileged")).toBe(true);
      expect(yield* exists(stateDirectory, "proxy.tlds")).toBe(false);
      expect(yield* exists(stateDirectory, "proxy.lan")).toBe(false);
      const pid = yield* readPid(stateDirectory);
      expect(yield* isAlive(pid)).toBe(true);

      // Another run (the providers build again) finds it running and leaves it alone.
      const second = yield* stack.deploy(program("proxy-reuse"));
      expect(second).toEqual(first);
      expect(yield* readPid(stateDirectory)).toBe(pid);
      expect((yield* stack.plan(program("proxy-reuse"))).resources.Proxy?.action).toBe("noop");

      // The proxy belongs to the machine: destroying the stack leaves it running.
      yield* stack.destroy();
      expect(yield* readPid(stateDirectory)).toBe(pid);
      expect(yield* isAlive(pid)).toBe(true);
    }),
  { tags: ["local"], timeout: 120_000 },
);

// The providers build, and so acquire the proxy, before a `test.provider` body runs: what
// the scenarios below need to be there already is arranged in `beforeAll`.
const plain = TestProxy.make();
const incompatible = Test.make({ providers: plain.providers(), dev: true, stage: "dev_alice" });
// A plain-HTTP proxy, started by someone else, on the settings' port and directory.
const plainRunning = incompatible.beforeAll(
  Effect.gen(function* () {
    const stateDirectory = yield* plain.stateDirectory;
    const port = yield* plain.port;
    yield* TestProxy.startPortless(stateDirectory, port, ["--no-tls"]);
    return { pid: yield* readPid(stateDirectory), routes: yield* readRoutes(stateDirectory) };
  }),
);
incompatible.afterAll(plain.stop);

incompatible.test.provider(
  "Proxy rejects a running proxy that can't serve the stack, and never touches it",
  (stack) =>
    Effect.gen(function* () {
      const stateDirectory = yield* plain.stateDirectory;
      const port = yield* plain.port;
      const { pid, routes } = yield* plainRunning;

      const error = yield* Effect.flip(stack.deploy(program("proxy-incompatible")));
      expect(tagOf(error)).toBe("ProxyIncompatible");
      expect(error).toMatchObject({ stateDirectory, port });
      const mismatches = (error as unknown as { mismatches: ReadonlyArray<string> }).mismatches;
      expect(mismatches.join("\n")).toContain("plain HTTP");
      expect(mismatches.join("\n")).toContain("unprivileged");
      // The message says how to fix it.
      expect((error as Error).message).toContain("portless proxy stop");

      // Nothing was stopped, restarted or reconfigured.
      expect(yield* readPid(stateDirectory)).toBe(pid);
      expect(yield* isAlive(pid)).toBe(true);
      expect(yield* exists(stateDirectory, "proxy.tls")).toBe(false);
      expect(yield* exists(stateDirectory, "proxy.unprivileged")).toBe(false);
      expect(yield* readRoutes(stateDirectory)).toEqual(routes);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

const other = TestProxy.make();
const elsewhere = Test.make({ providers: other.providers(), dev: true, stage: "dev_alice" });
// A Portless proxy that holds the port from another state directory.
const foreign = elsewhere.beforeAll(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDirectory = yield* fs.makeTempDirectory({ prefix: "alchemy-portless-foreign-" });
    const port = yield* other.port;
    yield* TestProxy.startPortless(stateDirectory, port, ["--https", "--unprivileged"]);
    return { stateDirectory, port };
  }),
);
elsewhere.afterAll(
  Effect.gen(function* () {
    const { stateDirectory, port } = yield* foreign;
    const fs = yield* FileSystem.FileSystem;
    yield* TestProxy.stopPortless(stateDirectory, port).pipe(Effect.ignore);
    yield* fs.remove(stateDirectory, { recursive: true, force: true });
  }),
);
elsewhere.afterAll(other.stop);

elsewhere.test.provider(
  "Proxy rejects a Portless proxy that runs from another state directory",
  (stack) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(stack.deploy(program("proxy-elsewhere")));
      expect(tagOf(error)).toBe("ProxyElsewhere");
      expect(error).toMatchObject({
        port: yield* other.port,
        stateDirectory: yield* other.stateDirectory,
      });
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

const held = TestProxy.make();
const occupied = Test.make({ providers: held.providers(), dev: true, stage: "dev_alice" });
// Something that is not Portless listens on the port, and never answers.
const occupant = occupied.beforeAll(
  Effect.gen(function* () {
    const port = yield* held.port;
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    yield* Effect.callback<void>((resume) => {
      server.listen(port, "127.0.0.1", () => resume(Effect.void));
    });
    return { server, sockets };
  }),
);
occupied.afterAll(
  Effect.gen(function* () {
    const { server, sockets } = yield* occupant;
    for (const socket of sockets) socket.destroy();
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    });
  }),
);
occupied.afterAll(held.stop);

occupied.test.provider(
  "Proxy names what holds its port when it isn't a Portless proxy",
  (stack) =>
    Effect.gen(function* () {
      const port = yield* held.port;
      const error = yield* Effect.flip(stack.deploy(program("proxy-held")));
      expect(tagOf(error)).toBe("ProxyPortInUse");
      expect(error).toMatchObject({ port });
      expect((error as Error).message).toContain("PORTLESS_PORT");
      // Nothing was started in its place.
      expect(yield* exists(yield* held.stateDirectory, "proxy.pid")).toBe(false);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);
