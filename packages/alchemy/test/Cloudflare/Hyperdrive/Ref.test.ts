import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import { assert, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import HyperdriveRefWorker, {
  REF_CONFIG_NAME,
  RefByName,
} from "./fixtures/ref-worker.ts";

const { test } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Bounded spaced schedule — rides out fresh workers.dev cold-start
        // 404s without blowing past the test timeout on a real failure.
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(30),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

test.provider(
  "Ref binds an existing config without managing it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // A real reachable Postgres origin for the config under reference.
      const { origin } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("HyperdriveRefProject");
          return { origin: project.origin };
        }),
      );

      // The referenced config is created OUTSIDE the stack (standing in for
      // a dashboard-created config shared with another system). Reruns
      // self-heal: drop any leftover from an interrupted run first.
      const leftover =
        yield* Cloudflare.Hyperdrive.findConfigByName(REF_CONFIG_NAME);
      if (leftover) {
        yield* hyperdrive.deleteConfig({
          accountId,
          hyperdriveId: leftover.id,
        });
      }
      const created = yield* hyperdrive.createConfig({
        accountId,
        name: REF_CONFIG_NAME,
        origin: {
          scheme: origin.scheme,
          host: origin.host,
          port: origin.port,
          database: origin.database,
          user: origin.user,
          password: Redacted.value(origin.password),
        },
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          // Keep the origin project deployed alongside the refs.
          yield* Neon.Project("HyperdriveRefProject");
          const refById = yield* Cloudflare.Hyperdrive.Ref(
            "HyperdriveRefById",
            {
              hyperdriveId: created.id,
            },
          );
          const refByName = yield* RefByName;
          const worker = yield* HyperdriveRefWorker;
          return { refById, refByName, worker };
        }),
      );

      // Both addressing modes resolve the same out-of-band config.
      expect(deployed.refById.hyperdriveId).toEqual(created.id);
      expect(deployed.refById.name).toEqual(REF_CONFIG_NAME);
      expect(deployed.refByName.hyperdriveId).toEqual(created.id);

      // The deployed worker's runtime binding resolves the referenced config.
      const meta = (yield* getJsonReady(`${deployed.worker.url}/meta`)) as {
        host: string;
        port: number;
        database: string;
      };
      expect(meta.host).toBeTruthy();
      expect(meta.port).toBeGreaterThan(0);
      expect(meta.database).toBe(origin.database);

      yield* stack.destroy();

      // The core Ref semantic: destroy dropped the state rows but never
      // touched the referenced config.
      const survived = yield* hyperdrive.getConfig({
        accountId,
        hyperdriveId: created.id,
      });
      expect(survived.id).toEqual(created.id);
      expect(survived.name).toEqual(REF_CONFIG_NAME);
      assert("host" in survived.origin, "origin must have a host");
      expect(survived.origin.host).toEqual(origin.host);

      yield* hyperdrive.deleteConfig({ accountId, hyperdriveId: created.id });
    }).pipe(logLevel),
  { timeout: 300_000 },
);
