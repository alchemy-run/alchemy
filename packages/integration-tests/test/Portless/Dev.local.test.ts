import * as Portless from "@alchemy.run/portless";
import { run } from "@alchemy.run/portless/internal/Run";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { scratchStack } from "@alchemy.run/test/Core";
import { findAvailablePort } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as pathe from "pathe";
import {
  eventually,
  isAlive,
  processGroupOf,
  readRoutes,
  routeOf,
  waitForDeath,
} from "./fixtures/Processes.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

const proxy = TestProxy.make();
const options = { providers: proxy.providers(), dev: true, stage: "dev_alice" } as const;
const { test, afterAll } = Test.make(options);
afterAll(proxy.stop);

const server = pathe.resolve(import.meta.dirname, "fixtures/server.mjs");

test.provider(
  "Dev serves its origin over HTTPS, as a route owned by the sidecar",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-serves" });
          const api = yield* Portless.Dev("Api", {
            proxy,
            command: `node ${server}`,
            env: { SERVER_NAME: "api" },
          });
          return { proxy, api };
        }),
      );
      const port = yield* proxy.port;
      const stateDirectory = yield* proxy.stateDirectory;
      // dev_alice is made DNS-safe: dev-alice.
      expect(deployed.api.hostname).toBe("dev-alice.api.dev-serves.localhost");
      expect(deployed.api.origin).toBe(`https://dev-alice.api.dev-serves.localhost:${port}`);
      expect(deployed.proxy).toMatchObject({ domain: "dev-serves", port, stateDirectory });
      expect(deployed.proxy.certificateAuthority).toBe(pathe.join(stateDirectory, "ca.pem"));

      const response = yield* TestProxy.serving(deployed.api.origin, deployed.proxy);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        name: "api",
        port: deployed.api.port,
        host: "127.0.0.1",
        portlessUrl: deployed.api.origin,
        stateDirectory,
        requestHost: `dev-alice.api.dev-serves.localhost:${port}`,
      });
      // The child trusts the proxy's CA through a bundle that holds it.
      const fs = yield* FileSystem.FileSystem;
      const bundle = yield* fs.readFileString(body.extraCaCerts);
      const ca = yield* fs.readFileString(deployed.proxy.certificateAuthority);
      expect(bundle.replaceAll(/\s/g, "")).toContain(ca.replaceAll(/\s/g, ""));

      // The route belongs to the sidecar, which outlives this process's reloads, and
      // records the command's process group the way Portless does.
      const route = yield* routeOf(stateDirectory, deployed.api.hostname);
      expect(route).toBeDefined();
      expect(route!.port).toBe(deployed.api.port);
      expect(route!.pid).not.toBe(process.pid);
      expect(yield* isAlive(route!.pid)).toBe(true);
      expect(route!.childPgid).toBe(yield* processGroupOf(body.pid));
      // The group leader's start time, the way Portless writes it: ticks since boot on
      // Linux, `ps`'s `lstart` in the C locale and UTC on macOS.
      if (process.platform === "linux") {
        expect(route!.childStartTime).toMatch(/^\d+$/);
      } else {
        const lstart = yield* run(
          ChildProcess.make("ps", ["-o", "lstart=", "-p", String(route!.childPgid)], {
            env: { LC_ALL: "C", TZ: "UTC" },
            extendEnv: true,
          }),
        );
        expect(route!.childStartTime).toMatch(/^\w{3} \w{3} +\d+ [\d:]{8} \d{4}$/);
        expect(route!.childStartTime).toBe(lstart.stdout.trim().replaceAll(/\s+/g, " "));
      }

      yield* stack.destroy();
      yield* waitForDeath(body.pid);
      expect(yield* routeOf(stateDirectory, deployed.api.hostname)).toBeUndefined();
    }),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Origin names a service before it starts, and is the origin Dev resolves to",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const webPort = yield* findAvailablePort();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-origin" });
          // Api starts first and needs Web's origin; Web needs Api's.
          const webOrigin = yield* Portless.Origin("Web", { proxy, port: webPort });
          const api = yield* Portless.Dev("Api", {
            proxy,
            command: `node ${server}`,
            env: { CORS_ORIGIN: webOrigin },
          });
          const web = yield* Portless.Dev("Web", {
            proxy,
            port: webPort,
            command: `node ${server}`,
            env: { API_URL: api.origin },
          });
          return { proxy, webOrigin, api, web };
        }),
      );
      expect(deployed.webOrigin).toBe(deployed.web.origin);
      expect(deployed.web.port).toBe(webPort);
      const api = JSON.parse((yield* TestProxy.serving(deployed.api.origin, deployed.proxy)).body);
      const web = JSON.parse((yield* TestProxy.serving(deployed.web.origin, deployed.proxy)).body);
      expect(api.corsOrigin).toBe(deployed.web.origin);
      expect(web.apiUrl).toBe(deployed.api.origin);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "an unchanged redeploy keeps the process and its route, a changed one restarts both",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (name: string) =>
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-reload" });
          const api = yield* Portless.Dev("Api", {
            proxy,
            command: `node ${server}`,
            env: { SERVER_NAME: name },
          });
          return { proxy, api };
        });

      const first = yield* stack.deploy(program("v1"));
      const stateDirectory = yield* proxy.stateDirectory;
      const before = JSON.parse((yield* TestProxy.serving(first.api.origin, first.proxy)).body);
      const routeBefore = yield* routeOf(stateDirectory, first.api.hostname);

      // A reload of the stack program builds the providers again; the sidecar, and
      // with it the command and its route, stays.
      const again = yield* stack.deploy(program("v1"));
      expect(again.api.origin).toBe(first.api.origin);
      const after = JSON.parse((yield* TestProxy.serving(again.api.origin, again.proxy)).body);
      expect(after.pid).toBe(before.pid);
      expect(yield* routeOf(stateDirectory, first.api.hostname)).toEqual(routeBefore);

      const changed = yield* stack.deploy(program("v2"));
      const restarted = yield* eventually(
        TestProxy.get(changed.api.origin, changed.proxy).pipe(
          Effect.map((response) => JSON.parse(response.body)),
          Effect.orElseSucceed(() => ({ name: "" })),
        ),
        (body) => body.name === "v2",
        "the restarted command answering",
      );
      expect(restarted.pid).not.toBe(before.pid);
      yield* waitForDeath(before.pid);
      const routeAfter = yield* routeOf(stateDirectory, first.api.hostname);
      expect(routeAfter!.childPgid).toBe(yield* processGroupOf(restarted.pid));

      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test.provider(
    `a Dev that ${signal === "SIGKILL" ? "crashes" : "is stopped"} answers 404 and its resource shows an update on the next plan`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: `dev-${signal.toLowerCase()}` });
          const api = yield* Portless.Dev("Api", { proxy, command: `node ${server}` });
          return { proxy, api };
        });
        const deployed = yield* stack.deploy(program);
        const stateDirectory = yield* proxy.stateDirectory;
        const body = JSON.parse(
          (yield* TestProxy.serving(deployed.api.origin, deployed.proxy)).body,
        );
        expect((yield* stack.plan(program)).resources.Api?.action).toBe("noop");

        const route = yield* routeOf(stateDirectory, deployed.api.hostname);
        process.kill(-route!.childPgid!, signal);
        yield* waitForDeath(body.pid);

        yield* TestProxy.answers(deployed.api.origin, deployed.proxy, 404);
        expect(yield* routeOf(stateDirectory, deployed.api.hostname)).toBeUndefined();
        expect((yield* stack.plan(program)).resources.Api?.action).toBe("update");

        // The next deploy starts it again, under the same name.
        const restarted = yield* stack.deploy(program);
        expect(restarted.api.origin).toBe(deployed.api.origin);
        const again = JSON.parse(
          (yield* TestProxy.serving(restarted.api.origin, restarted.proxy)).body,
        );
        expect(again.pid).not.toBe(body.pid);

        yield* stack.destroy();
      }),
    { tags: ["local"], timeout: 120_000 },
  );
}

test.provider(
  "two stages get separate routes and destroying one leaves the other",
  (alice) =>
    Effect.gen(function* () {
      const bob = scratchStack({ ...options, stage: "dev_bob" }, `${alice.name}-bob`);
      const program = Effect.gen(function* () {
        const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-stages" });
        const api = yield* Portless.Dev("Api", {
          proxy,
          command: `node ${server}`,
          env: { SERVER_NAME: "api" },
        });
        return { proxy, api };
      });
      yield* alice.destroy();
      yield* bob.destroy();

      const a = yield* alice.deploy(program);
      const b = yield* bob.deploy(program);
      const stateDirectory = yield* proxy.stateDirectory;
      expect(a.api.hostname).toBe("dev-alice.api.dev-stages.localhost");
      expect(b.api.hostname).toBe("dev-bob.api.dev-stages.localhost");
      const aBody = JSON.parse((yield* TestProxy.serving(a.api.origin, a.proxy)).body);
      const bBody = JSON.parse((yield* TestProxy.serving(b.api.origin, b.proxy)).body);
      expect(aBody.pid).not.toBe(bBody.pid);
      expect(aBody.portlessUrl).toBe(a.api.origin);
      expect(bBody.portlessUrl).toBe(b.api.origin);
      expect((yield* readRoutes(stateDirectory)).map((route) => route.hostname)).toEqual(
        expect.arrayContaining([a.api.hostname, b.api.hostname]),
      );

      yield* bob.destroy();
      yield* TestProxy.answers(b.api.origin, b.proxy, 404);
      yield* waitForDeath(bBody.pid);
      // Alice is untouched: same process, still served.
      const stillA = JSON.parse((yield* TestProxy.serving(a.api.origin, a.proxy)).body);
      expect(stillA.pid).toBe(aBody.pid);
      expect(yield* routeOf(stateDirectory, b.api.hostname)).toBeUndefined();

      yield* alice.destroy();
      yield* waitForDeath(aBody.pid);
    }),
  { tags: ["local"], timeout: 120_000 },
);

test.provider(
  "Dev keeps the port it is given across restarts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const port = yield* findAvailablePort();
      const program = (name: string) =>
        Effect.gen(function* () {
          const proxy = yield* Portless.Proxy("Proxy", { domain: "dev-port" });
          return yield* Portless.Dev("Api", {
            proxy,
            port,
            command: `node ${server}`,
            env: { SERVER_NAME: name },
          });
        });
      const first = yield* stack.deploy(program("v1"));
      expect(first.port).toBe(port);
      const second = yield* stack.deploy(program("v2"));
      expect(second.port).toBe(port);
      yield* stack.destroy();
    }),
  { tags: ["local"], timeout: 120_000 },
);
