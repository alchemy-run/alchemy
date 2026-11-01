import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { noHarborIdentity } from "../ContainerRegistry/harbor.ts";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import EffectApp from "./fixtures/effect-app.ts";
import { Ping, Stage } from "./fixtures/stack.ts";
import { asManager, CF_MEMORY_IN_MB, deployer, EXAMPLE_IMAGE, expectGone } from "./helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("cloudfoundry", "app"), timeout: 1_500_000 } as const;

/** A route's first answers can be the router's 404, until it has picked up the app. */
const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(response),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

test.provider(
  "neither main nor image fails before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Stackit.CloudFoundry.App("NoSource", {
            spaceId: "00000000-0000-0000-0000-000000000000",
            credentials: {
              apiUrl: "https://api.invalid.example",
              username: "nobody",
              password: Redacted.make("nothing"),
            },
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "Stackit.CloudFoundry.AppSourceRequired" });
      yield* stack.destroy();
    }).pipe(logLevel),
  { ...options, timeout: 120_000 },
);

test.provider(
  "a pre-built image: start, new variables, scale, route and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (args: {
        env: Record<string, string>;
        instances?: number;
        name?: string;
        noRoute?: boolean;
      }) =>
        Effect.gen(function* () {
          const target = yield* deployer("Image");
          const app = yield* Stackit.CloudFoundry.App("ImageApp", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            image: EXAMPLE_IMAGE,
            memoryInMb: CF_MEMORY_IN_MB,
            labels: { env: "test" },
            ...args,
          });
          return { manager: target.manager, app };
        });

      const created = yield* stack.deploy(program({ env: { GREETING: "one", DROPPED: "x" } }));
      const login = created.manager;
      expect(created.app.state).toEqual("STARTED");
      expect(created.app.url).toMatch(/^https:\/\//);
      expect(created.app.image).toEqual(EXAMPLE_IMAGE);
      expect(created.app.memoryInMb).toEqual(CF_MEMORY_IN_MB);
      expect(created.app.labels).toEqual({ env: "test" });

      const { appId, routeId } = created.app;
      const answer = yield* getOk(created.app.url!);
      expect(answer.status).toEqual(200);

      // Out of band: the variables, the droplet and the route.
      const variables = yield* cf
        .getEnvironmentVariablesForApp({ guid: appId })
        .pipe(asManager(login));
      expect(Redacted.value(variables.var!.GREETING as Redacted.Redacted<string>)).toEqual("one");
      const droplet = yield* cf.getCurrentDropletForApp({ guid: appId }).pipe(asManager(login));
      expect(droplet.image).toEqual(EXAMPLE_IMAGE);
      const destinations = yield* cf
        .listDestinationsForRoute({ guid: routeId! })
        .pipe(asManager(login));
      expect(destinations.destinations?.map((d) => d.app?.guid)).toEqual([appId]);

      const unchanged = yield* stack.plan(program({ env: { GREETING: "one", DROPPED: "x" } }));
      expect(unchanged.resources.ImageApp).toMatchObject({ action: "noop" });

      // New variables roll the app, keep the droplet, and remove what this resource set.
      const updated = yield* stack.deploy(program({ env: { GREETING: "two" }, instances: 2 }));
      expect(updated.app.appId).toEqual(appId);
      expect(updated.app.dropletId).toEqual(created.app.dropletId);
      expect(updated.app.instances).toEqual(2);
      const afterUpdate = yield* cf
        .getEnvironmentVariablesForApp({ guid: appId })
        .pipe(asManager(login));
      expect(Redacted.value(afterUpdate.var!.GREETING as Redacted.Redacted<string>)).toEqual("two");
      expect(afterUpdate.var!.DROPPED).toBeUndefined();

      // A rename keeps the app. Dropping the route deletes the one this resource made.
      const renamed = yield* stack.deploy(
        program({ env: { GREETING: "two" }, name: "alchemy-test-cf-app", noRoute: true }),
      );
      expect(renamed.app.appId).toEqual(appId);
      expect(renamed.app.name).toEqual("alchemy-test-cf-app");
      expect(renamed.app.url).toBeUndefined();
      yield* expectGone(cf.getRoute({ guid: routeId! }).pipe(asManager(login)));

      // Dropping the app from the stack deletes it, with the manager still there.
      yield* stack.deploy(deployer("Image"));
      yield* expectGone(cf.getApp({ guid: appId }).pipe(asManager(login)));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a bound user-provided instance reaches VCAP_SERVICES, and unbinding removes the binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (bound: boolean) =>
        Effect.gen(function* () {
          const target = yield* deployer("Bound");
          const instance = yield* Stackit.CloudFoundry.ServiceInstance("BoundService", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            serviceCredentials: { apiKey: "not-a-secret" },
          });
          const app = yield* Stackit.CloudFoundry.App("BoundApp", {
            spaceId: target.space.spaceId,
            credentials: target.credentials,
            image: EXAMPLE_IMAGE,
            memoryInMb: CF_MEMORY_IN_MB,
            noRoute: true,
            services: bound ? [instance.serviceInstanceId] : [],
          });
          return { manager: target.manager, instance, app };
        });

      const bound = yield* stack.deploy(program(true));
      const bindingId = bound.app.serviceBindings[bound.instance.serviceInstanceId];
      expect(bindingId).toEqual(expect.any(String));
      const observed = yield* cf
        .getServiceCredentialBinding({ guid: bindingId! })
        .pipe(asManager(bound.manager));
      expect(observed.type).toEqual("app");

      const unbound = yield* stack.deploy(program(false));
      expect(unbound.app.serviceBindings).toEqual({});
      yield* expectGone(
        cf.getServiceCredentialBinding({ guid: bindingId! }).pipe(asManager(bound.manager)),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a chosen host replaces delete-first, and an app parked at no instances deploys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (args: { holder: "A" | "B"; instances: number; host?: string }) =>
        Effect.gen(function* () {
          const target = yield* deployer("Parked");
          const other = yield* Stackit.CloudFoundry.Space("ParkedOtherSpace", {
            organizationId: target.organization.organizationId,
            forceDestroy: true,
          });
          const app = yield* Stackit.CloudFoundry.App("ParkedApp", {
            spaceId: args.holder === "A" ? target.space.spaceId : other.spaceId,
            credentials: target.credentials,
            image: EXAMPLE_IMAGE,
            memoryInMb: CF_MEMORY_IN_MB,
            instances: args.instances,
            ...(args.host !== undefined ? { host: args.host } : {}),
          });
          return { app };
        });

      // No instances is a legal way to park an app, and has nothing to wait for.
      const parked = yield* stack.deploy(
        program({ holder: "A", instances: 0, host: "alchemy-test-cf-parked" }),
      );
      expect(parked.app.instances).toEqual(0);

      // The old app's route holds a chosen host until the old app goes.
      const chosen = yield* stack.plan(
        program({ holder: "B", instances: 0, host: "alchemy-test-cf-parked" }),
      );
      expect(chosen.resources.ParkedApp).toMatchObject({ action: "replace", deleteFirst: true });

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noHarborIdentity)(
  "both forms built from main: the async handler and the effectful class",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ping = yield* Ping;
          const effectful = yield* EffectApp;
          const stage = yield* Stage;
          return { ping, effectful, manager: stage.manager };
        }),
      );

      // The async form: `env` from the prop, no Effect in the bundle.
      const asyncResponse = yield* getOk(`${deployed.ping.url!}/hello`);
      const asyncBody = (yield* asyncResponse.json) as Record<string, unknown>;
      expect(asyncBody).toMatchObject({
        form: "async",
        greeting: "hello from async",
        path: "/hello",
      });

      // The effectful form: `/get-space` only answers if it signs with the created key.
      const effectResponse = yield* getOk(`${String(deployed.effectful.url)}/hello`);
      const effectBody = (yield* effectResponse.json) as { result?: Record<string, unknown> };
      expect(effectBody.result).toMatchObject({
        form: "effect",
        greeting: "hello from effect",
        keyIsPacked: true,
      });
      const spaceResponse = yield* getOk(`${String(deployed.effectful.url)}/get-space`);
      const spaceBody = (yield* spaceResponse.json) as { ok: boolean };
      expect(spaceBody.ok).toEqual(true);

      const login = deployed.manager;
      const appId = deployed.ping.appId;
      // Dropped apps go while the manager is still there to ask.
      yield* stack.deploy(Stage);
      yield* expectGone(cf.getApp({ guid: appId }).pipe(asManager(login)));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
