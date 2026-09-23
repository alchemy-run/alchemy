import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Api from "./fixtures/api.ts";
import ChecksApi, { ChecksSite } from "./fixtures/checks-api.ts";
import UnhealthyApi, { UnhealthySite } from "./fixtures/unhealthy-api.ts";
import { API_PORT, MARKER, Site, VOLUME_PATH } from "./fixtures/shared.ts";
import { ECHO_BODY, Echo } from "./fixtures/echo.ts";
import { fetchFrom, fetchOnce, nginx } from "./fixtures/flycast.ts";
import GatewayApi from "./fixtures/gateway-api.ts";
import UsersApi, { USERS_BODY } from "./fixtures/users-api.ts";
import SecureGateway from "./fixtures/secure-gateway.ts";
import SecureUsers, { SECURE_USERS_BODY } from "./fixtures/secure-users.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (appName: string, machineId: string) =>
  machines
    .getMachine({
      app_name: appName,
      machine_id: machineId,
    })
    .pipe(
      Effect.map((machine) =>
        machine.state === "destroyed" ? ("gone" as const) : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "deploy token probe is typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("TokenSite");
        }),
      );

      const minted = yield* machines.createAppDeployToken({
        app_name: app.appName,
      });
      expect(minted.token).toEqual(expect.any(String));
      expect(minted.token!.length).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
    timeout: 90_000,
  },
);

test.provider(
  "create, serve, mount, and delete a service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Site;
          const ip = yield* Fly.IpAssignment("Shared", {
            app,
            type: "shared_v4",
          });
          const api = yield* Api;
          return { app, ip, api };
        }),
      );

      expect(deployed.api.machineId).toEqual(expect.any(String));
      expect(deployed.api.machineId.length).toBeGreaterThan(0);
      expect(deployed.api.machineIds).toEqual([deployed.api.machineId]);
      expect(deployed.api.count).toEqual(1);
      expect(deployed.api.appName).toEqual(deployed.app.appName);
      expect(deployed.api.name).toEqual(expect.any(String));
      expect(deployed.api.region).toEqual("iad");
      expect(deployed.api.state).toEqual("started");
      expect(deployed.api.url).toEqual(
        `https://${deployed.app.appName}.fly.dev`,
      );
      expect(deployed.api.code.hash).toEqual(expect.any(String));
      expect(deployed.api.code.hash.length).toBeGreaterThan(0);
      expect(deployed.api.mounts[0]?.path).toEqual(VOLUME_PATH);
      expect(deployed.api.mounts[0]?.volumeId).toEqual(expect.any(String));

      const fetched = yield* machines.getMachine({
        app_name: deployed.api.appName,
        machine_id: deployed.api.machineId,
      });
      expect(fetched.id).toEqual(deployed.api.machineId);
      expect(fetched.name).toEqual(deployed.api.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.state).toEqual("started");
      expect(fetched.config?.metadata?.["alchemy.type"]).toEqual("Fly.Service");
      expect(fetched.config?.metadata?.["alchemy.stack"]).toEqual(
        expect.any(String),
      );
      expect(fetched.config?.image).toEqual(
        expect.stringContaining("registry.fly.io/"),
      );
      expect(fetched.config?.image).toEqual(
        expect.stringContaining(deployed.api.code.hash),
      );
      expect(fetched.config?.mounts?.[0]?.path).toEqual(VOLUME_PATH);
      expect(fetched.config?.mounts?.[0]?.volume).toEqual(
        deployed.api.mounts[0]?.volumeId,
      );
      expect(fetched.config?.metadata?.["alchemy.replica"]).toEqual("0");
      expect(fetched.config?.guest?.cpus).toEqual(1);
      expect(fetched.config?.guest?.memory_mb).toEqual(256);
      const defaultCheck = fetched.config?.services?.[0]?.checks?.[0];
      expect(defaultCheck?.type).toEqual("tcp");
      expect(defaultCheck?.port).toEqual(API_PORT);
      expect(defaultCheck?.interval).toEqual("10s");
      expect(defaultCheck?.timeout).toEqual("2s");
      expect(defaultCheck?.grace_period).toEqual("30s");

      const liveVolume = yield* machines.getVolumeById({
        app_name: deployed.api.appName,
        volume_id: deployed.api.mounts[0]!.volumeId,
      });
      expect(liveVolume.attached_machine_id).toEqual(deployed.api.machineId);

      const provider = yield* Provider.findProvider(Fly.Service);
      const all = yield* provider.list();
      const found = all.find(
        (service) => service.machineId === deployed.api.machineId,
      );
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.api.appName);
      expect(found?.name).toEqual(deployed.api.name);
      expect(found?.region).toEqual("iad");

      const body = yield* HttpClient.get(deployed.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
        Effect.map((value) => value as { text: string; path: string }),
      );
      expect(body.path).toEqual(VOLUME_PATH);
      expect(body.text).toEqual(MARKER);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.api.appName,
        deployed.api.machineId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:service",
      "provider:fly:volume",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "destroy recovers a service and its volumes after initial checks fail",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(UnhealthySite);
      const result = yield* stack.deploy(UnhealthyApi).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "Fly.ReplicaChecksNotPassing",
        });
      }
      const live = yield* machines.listMachines({ app_name: app.appName });
      expect(
        live.filter((machine) => machine.state !== "destroyed"),
      ).toHaveLength(1);
      const volumes = yield* machines.listVolumes({ app_name: app.appName });
      expect(volumes).toHaveLength(2);
      const attached = volumes.find(
        (volume) => volume.attached_machine_id === live[0]?.id,
      );
      expect(attached).toBeDefined();
      const blocked = yield* machines
        .deleteVolume({
          app_name: app.appName,
          volume_id: attached!.id!,
        })
        .pipe(Effect.flip);
      expect(blocked._tag).toBe("VolumeAttached");
      yield* stack.destroy();
      for (const machine of live) {
        expect(yield* waitUntilGone(app.appName, machine.id!)).toBe("gone");
      }
      for (const volume of volumes) {
        const missing = yield* machines
          .getVolumeById({
            app_name: app.appName,
            volume_id: volume.id!,
          })
          .pipe(Effect.flip);
        expect(missing._tag).toBe("NotFound");
      }
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "provider:fly:volume",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "creates a custom service check and reports it passing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* ChecksSite;
          const service = yield* ChecksApi;
          return { app, service };
        }),
      );

      const live = yield* machines.getMachine({
        app_name: deployed.app.appName,
        machine_id: deployed.service.machineId,
      });
      const check = live.config?.services?.[0]?.checks?.[0];
      expect(check?.type).toEqual("http");
      expect(check?.port).toEqual(API_PORT);
      expect(check?.method).toEqual("GET");
      expect(check?.path).toEqual("/health");
      expect(check?.protocol).toEqual("http");
      expect(check?.interval).toEqual("15s");
      expect(check?.timeout).toEqual("3s");
      expect(check?.grace_period).toEqual("20s");

      const serviceChecks =
        live.checks?.filter((check) =>
          check.name?.startsWith("servicecheck-"),
        ) ?? [];
      expect(serviceChecks).toHaveLength(1);
      expect(serviceChecks[0]?.name).toEqual(
        `servicecheck-00-http-${API_PORT}`,
      );
      expect(serviceChecks[0]?.status).toEqual("passing");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.service.appName,
        deployed.service.machineId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
    timeout: 180_000,
  },
);

const ownedTags = [
  "provider:fly",
  "provider:fly:app",
  "provider:fly:machine",
  "provider:fly:service",
  "live",
];

/** Observed address kinds on an App. */
const addressKinds = (appName: string) =>
  machines
    .listAppIPAssignments({ app_name: appName })
    .pipe(
      Effect.map((res) =>
        (res.ips ?? [])
          .map((ip) =>
            ip.network !== undefined && ip.network !== null
              ? "flycast"
              : ip.shared === true
                ? "shared_v4"
                : (ip.ip ?? "").includes(":")
                  ? "v6"
                  : "v4",
          )
          .sort(),
      ),
    );

const appGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const getText = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.text
        : Effect.fail(new Error(`${url} returned ${res.status}`)),
    ),
    Effect.retry({ schedule: Schedule.spaced("4 seconds"), times: 15 }),
  );

test.provider(
  "a Service owns its App and serves its public url",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const owned = yield* stack.deploy(Echo());
      expect(owned.ownsApp).toBe(true);
      expect(owned.url).toEqual(`https://${owned.appName}.fly.dev`);
      expect(owned.privateUrl).toBeUndefined();
      expect(yield* addressKinds(owned.appName)).toEqual([
        "flycast",
        "shared_v4",
        "v6",
      ]);
      expect(yield* getText(owned.url!)).toEqual(ECHO_BODY);

      // Moving into a shared App replaces the Service and deletes its App.
      const moved = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.App("EchoSharedSite");
          return yield* Echo({ app: site });
        }),
      );
      expect(moved.ownsApp).toBe(false);
      expect(moved.appName).not.toEqual(owned.appName);
      expect(moved.url).toEqual(`https://${moved.appName}.fly.dev`);
      expect(moved.privateUrl).toBeUndefined();
      expect(yield* appGone(owned.appName)).toBe(true);

      yield* stack.destroy();
      expect(yield* appGone(moved.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 300_000 },
);

test.provider(
  "a private Service answers over Flycast and turning it public keeps its App",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (isPublic: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const client = yield* Fly.App("EchoCallerSite");
            const caller = yield* Fly.Machine("Caller", {
              app: client,
              ...nginx,
            });
            const echo = yield* Echo({ public: isPublic });
            return { caller, echo };
          }),
        );

      const hidden = yield* deploy(false);
      expect(hidden.echo.ownsApp).toBe(true);
      expect(hidden.echo.url).toBeUndefined();
      expect(hidden.echo.privateUrl).toEqual(
        `http://${hidden.echo.appName}.flycast`,
      );
      expect(yield* addressKinds(hidden.echo.appName)).toEqual(["flycast"]);
      expect(
        yield* fetchFrom(hidden.caller, hidden.echo.privateUrl!, ECHO_BODY),
      ).toContain(ECHO_BODY);

      const shown = yield* deploy(true);
      expect(shown.echo.appName).toEqual(hidden.echo.appName);
      expect(shown.echo.url).toEqual(`https://${shown.echo.appName}.fly.dev`);
      expect(yield* addressKinds(shown.echo.appName)).toEqual([
        "flycast",
        "shared_v4",
        "v6",
      ]);
      expect(yield* getText(shown.echo.url!)).toEqual(ECHO_BODY);

      const hiddenAgain = yield* deploy(false);
      expect(hiddenAgain.echo.appName).toEqual(hidden.echo.appName);
      expect(hiddenAgain.echo.url).toBeUndefined();
      expect(yield* addressKinds(hiddenAgain.echo.appName)).toEqual([
        "flycast",
      ]);

      yield* stack.destroy();
      expect(yield* appGone(hidden.echo.appName)).toBe(true);
      expect(yield* appGone(hidden.caller.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

test.provider(
  "public or network on a Service in a shared App is rejected before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("EchoInvalidSite"));
      for (const invalid of [{ public: false }, { network: "any-network" }]) {
        const failed = yield* stack
          .deploy(
            Effect.gen(function* () {
              const site = yield* Fly.App("EchoInvalidSite");
              return yield* Echo({ app: site, ...invalid });
            }),
          )
          .pipe(Effect.flip);
        expect(failed).toMatchObject({ _tag: "Fly.InvalidServiceProps" });
      }
      expect(yield* machines.listMachines({ app_name: app.appName })).toEqual(
        [],
      );
      yield* stack.destroy();
      expect(yield* appGone(app.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 120_000 },
);

test.provider(
  "a public Service calls a private Service at its privateUrl",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const users = yield* UsersApi;
          const gateway = yield* GatewayApi;
          return { users, gateway };
        }),
      );
      expect(deployed.users.url).toBeUndefined();
      expect(deployed.users.privateUrl).toEqual(
        `http://${deployed.users.appName}.flycast`,
      );
      expect(deployed.gateway.appName).not.toEqual(deployed.users.appName);
      expect(yield* getText(deployed.gateway.url!)).toEqual(USERS_BODY);

      yield* stack.destroy();
      expect(yield* appGone(deployed.users.appName)).toBe(true);
      expect(yield* appGone(deployed.gateway.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

test.provider(
  "Services on the stack network reach each other and nothing else reaches them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const users = yield* SecureUsers;
          const gateway = yield* SecureGateway;
          const outside = yield* Fly.App("OutsideSite");
          const outsider = yield* Fly.Machine("Outsider", {
            app: outside,
            ...nginx,
          });
          return {
            users,
            gateway,
            outsider,
            network: yield* Fly.stackNetwork,
          };
        }),
      );
      const { users, gateway, outsider, network } = deployed;
      expect(users.network).toEqual(network);
      expect(gateway.network).toEqual(network);
      expect(users.url).toBeUndefined();
      expect(users.privateUrl).toEqual(`http://${users.appName}.flycast`);
      for (const appName of [users.appName, gateway.appName]) {
        const app = yield* machines.getApp({ app_name: appName });
        expect(app.network).toEqual(network);
      }
      const flycast = (yield* machines.listAppIPAssignments({
        app_name: users.appName,
      })).ips;
      expect(flycast?.map((ip) => ip.network?.name)).toEqual([network]);

      // The public gateway reaches the private Service over the stack network.
      expect(yield* getText(gateway.url!)).toEqual(SECURE_USERS_BODY);

      // An App on the default network cannot resolve either private name.
      for (const url of [
        users.privateUrl!,
        `http://${users.appName}.internal:3000`,
      ]) {
        const response = yield* fetchOnce(outsider, url);
        expect(response).not.toContain(SECURE_USERS_BODY);
        expect(response).toContain("bad address");
      }

      yield* stack.destroy();
      for (const appName of [users.appName, gateway.appName, outsider.appName])
        expect(yield* appGone(appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);
