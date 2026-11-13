import * as Docker from "@alchemy.run/docker";
import * as Portless from "@alchemy.run/portless";
import * as Lan from "@alchemy.run/portless/internal/Lan";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { isAlive } from "./fixtures/Processes.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

// LAN mode, on a state directory and a high port of the test's own. The proxy pins `127.0.0.1` as
// its address (`PORTLESS_LAN_IP`, which Portless reads itself), so nothing here depends on, or
// advertises, this machine's network. It does listen on every interface for the length of a test,
// as LAN mode does; nothing in the machine's network configuration changes.

const server = pathe.resolve(import.meta.dirname, "fixtures/server.mjs");
const pinned = { PORTLESS_LAN_IP: "127.0.0.1" };

const readFile = (stateDirectory: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (yield* fs.readFileString(path.join(stateDirectory, name))).trim();
  });

const readPid = (stateDirectory: string) =>
  readFile(stateDirectory, "proxy.pid").pipe(Effect.map((text) => Number.parseInt(text, 10)));

const program = Effect.gen(function* () {
  const proxy = yield* Portless.Proxy("Proxy", { domain: "lan-test" });
  const api = yield* Portless.Dev("Api", {
    proxy,
    command: `node ${server}`,
    env: { SERVER_NAME: "api" },
  });
  const origin = yield* Portless.Origin("Api", { proxy });
  return { proxy, api, origin };
});

// ── a LAN proxy serves .local names, to every interface
const lan = TestProxy.make(pinned, { lan: true });
const serving = Test.make({ providers: lan.providers(), dev: true, stage: "dev_alice" });
serving.afterAll(lan.stop);

serving.test.provider.skipIf(!TestProxy.hasMdnsTool)(
  "Proxy in LAN mode names services under .local and serves them beyond loopback",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stateDirectory = yield* lan.stateDirectory;
      const port = yield* lan.port;
      const deployed = yield* stack.deploy(program);

      expect(deployed.proxy).toMatchObject({ tld: "local", port, stateDirectory });
      expect(deployed.api.hostname).toBe("dev-alice.api.lan-test.local");
      expect(deployed.api.origin).toBe(`https://dev-alice.api.lan-test.local:${port}`);
      // Origin names it the same before it starts.
      expect(deployed.origin).toBe(deployed.api.origin);
      // What Portless recorded: LAN mode, `.local`, and the address that was pinned.
      expect(yield* readFile(stateDirectory, "proxy.lan")).toBe("127.0.0.1");
      expect(yield* readFile(stateDirectory, "proxy.tlds")).toBe("local");

      const response = yield* TestProxy.serving(deployed.api.origin, deployed.proxy);
      expect(JSON.parse(response.body)).toMatchObject({
        name: "api",
        portlessUrl: deployed.api.origin,
        requestHost: `dev-alice.api.lan-test.local:${port}`,
      });

      // Any machine that can reach this one reaches it: here, by the address of this machine's own
      // network interface rather than loopback.
      const address = yield* Lan.networkAddress;
      if (address !== undefined) {
        const viaNetwork = yield* TestProxy.get(deployed.api.origin, deployed.proxy, "/", address);
        expect(viaNetwork.status).toBe(200);
      }
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

// ── a proxy without LAN mode turns other addresses away
const loopback = TestProxy.make();
const closed = Test.make({ providers: loopback.providers(), dev: true, stage: "dev_alice" });
closed.afterAll(loopback.stop);

closed.test.provider(
  "Proxy without LAN mode serves this machine only",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Portless.Proxy("Proxy", { domain: "lan-test" });
        }),
      );
      expect(deployed.tld).toBe("localhost");
      const address = yield* Lan.networkAddress;
      if (address !== undefined) {
        // The unprivileged proxy listens on every interface to get its port, and drops the
        // connections of peers that aren't this machine.
        const refused = yield* Effect.flip(
          TestProxy.get(`https://x.lan-test.localhost:${deployed.port}`, deployed, "/", address),
        );
        expect(refused).toBeInstanceOf(Error);
      }
    }),
  { tags: ["local"], timeout: 120_000 },
);

// ── a running proxy of the other kind is turned away, and its own kind is reused
const proxyOnly = Effect.gen(function* () {
  return yield* Portless.Proxy("Proxy", { domain: "lan-test" });
});

// A stack in LAN mode, and a loopback proxy runs. (The host's LAN check is set aside: this is
// about the running proxy.)
const needsLan = TestProxy.make(pinned, { lan: true, lanCheck: Lan.LanNone });
const loopbackRunning = Test.make({
  providers: needsLan.providers(),
  dev: true,
  stage: "dev_alice",
});
const loopbackStarted = loopbackRunning.beforeAll(
  Effect.gen(function* () {
    const stateDirectory = yield* needsLan.stateDirectory;
    const port = yield* needsLan.port;
    yield* TestProxy.startPortless(stateDirectory, port, [
      "--unprivileged",
      "--https",
      "--tld",
      "localhost",
    ]);
    return { pid: yield* readPid(stateDirectory) };
  }),
);
loopbackRunning.afterAll(needsLan.stop);

loopbackRunning.test.provider(
  "Proxy in LAN mode rejects a running proxy that only serves loopback, and never touches it",
  (stack) =>
    Effect.gen(function* () {
      const stateDirectory = yield* needsLan.stateDirectory;
      const { pid } = yield* loopbackStarted;
      const error = yield* Effect.flip(stack.deploy(proxyOnly));
      expect(error).toMatchObject({
        _tag: "ProxyIncompatible",
        mismatches: expect.arrayContaining([
          "it serves .localhost, this stack needs .local only",
          "it isn't in LAN mode, which this stack needs for .local names reachable from other machines",
        ]),
      });
      expect(yield* readPid(stateDirectory)).toBe(pid);
      expect(yield* isAlive(pid)).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

// A stack without LAN mode, and a LAN proxy runs.
const noLan = TestProxy.make(pinned);
const lanRunning = Test.make({ providers: noLan.providers(), dev: true, stage: "dev_alice" });
const lanStarted = lanRunning.beforeAll(
  TestProxy.hasMdnsTool
    ? Effect.gen(function* () {
        const stateDirectory = yield* noLan.stateDirectory;
        const port = yield* noLan.port;
        yield* TestProxy.startPortless(
          stateDirectory,
          port,
          ["--unprivileged", "--https", "--lan"],
          pinned,
        );
        return { pid: yield* readPid(stateDirectory) };
      })
    : Effect.succeed({ pid: 0 }),
);
lanRunning.afterAll(noLan.stop);

lanRunning.test.provider.skipIf(!TestProxy.hasMdnsTool)(
  "Proxy without LAN mode rejects a running LAN proxy, and never touches it",
  (stack) =>
    Effect.gen(function* () {
      const stateDirectory = yield* noLan.stateDirectory;
      const { pid } = yield* lanStarted;
      const error = yield* Effect.flip(stack.deploy(proxyOnly));
      expect(error).toMatchObject({
        _tag: "ProxyIncompatible",
        mismatches: expect.arrayContaining(["it runs in LAN mode, which serves .local names"]),
      });
      expect(yield* readPid(stateDirectory)).toBe(pid);
      expect(yield* isAlive(pid)).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

// A stack in LAN mode, and a LAN proxy runs: it is reused.
const sameLan = TestProxy.make(pinned, { lan: true });
const lanReused = Test.make({ providers: sameLan.providers(), dev: true, stage: "dev_alice" });
const sameStarted = lanReused.beforeAll(
  TestProxy.hasMdnsTool
    ? Effect.gen(function* () {
        const stateDirectory = yield* sameLan.stateDirectory;
        const port = yield* sameLan.port;
        yield* TestProxy.startPortless(
          stateDirectory,
          port,
          ["--unprivileged", "--https", "--lan"],
          pinned,
        );
        return { pid: yield* readPid(stateDirectory) };
      })
    : Effect.succeed({ pid: 0 }),
);
lanReused.afterAll(sameLan.stop);

lanReused.test.provider.skipIf(!TestProxy.hasMdnsTool)(
  "Proxy in LAN mode reuses a running LAN proxy",
  (stack) =>
    Effect.gen(function* () {
      const stateDirectory = yield* sameLan.stateDirectory;
      const { pid } = yield* sameStarted;
      const deployed = yield* stack.deploy(proxyOnly);
      expect(deployed).toMatchObject({ tld: "local", stateDirectory });
      expect(yield* readPid(stateDirectory)).toBe(pid);
      expect(yield* isAlive(pid)).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

// The Docker example in the docs, type-checked and never run: a container reaches a service by its
// name through `extraHosts`, and trusts the proxy's CA through a mounted file.
export const containerExample = Effect.gen(function* () {
  const proxy = yield* Portless.Proxy("Proxy", { domain: "myapp" });
  const api = yield* Portless.Dev("Api", { proxy, command: "node --watch server.ts" });

  return yield* Docker.Container("worker", {
    image: "ghcr.io/acme/worker:latest",
    // The service's name resolves to the host, where the proxy listens.
    extraHosts: [`${api.hostname}:host-gateway`],
    volumes: [
      {
        hostPath: proxy.certificateAuthority,
        containerPath: "/etc/portless/ca.pem",
        readOnly: true,
      },
    ],
    environment: {
      NODE_EXTRA_CA_CERTS: "/etc/portless/ca.pem",
      API_URL: api.origin,
    },
    start: true,
  });
});
