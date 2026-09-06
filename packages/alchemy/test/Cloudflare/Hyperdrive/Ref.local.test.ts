import * as Cloudflare from "@/Cloudflare/index.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Neon from "@/Neon/index.ts";
import * as Test from "@/Test/Alchemy";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import HyperdriveRefLocalWorker, {
  LocalHyperdriveRef,
  REF_LOCAL_CONFIG_NAME,
} from "./fixtures/ref-local-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy, matching
// the process topology of the real `alchemy dev` command. Hyperdrive.Ref is
// mode-agnostic (a single observe-only provider), so it still resolves the
// real cloud config even in dev; only the worker binding is emulated.
const { test } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
  dev: true,
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
        // Cap the backoff: an uncapped exponential turns a persistent
        // non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

type QueryBody = {
  row: { sum: number; db: string };
  host: string;
};

test.provider(
  "Ref with a dev override round-trips SQL through the local passthrough",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // A real reachable Postgres origin for the config under reference.
      const { origin, databaseName } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("HyperdriveRefLocalProject");
          return { origin: project.origin, databaseName: project.databaseName };
        }),
      );

      // The referenced config is created OUTSIDE the stack; reruns
      // self-heal by dropping any leftover from an interrupted run first.
      const leftover = yield* Cloudflare.Hyperdrive.findConfigByName(
        REF_LOCAL_CONFIG_NAME,
      );
      if (leftover) {
        yield* hyperdrive.deleteConfig({
          accountId,
          hyperdriveId: leftover.id,
        });
      }
      const created = yield* hyperdrive.createConfig({
        accountId,
        name: REF_LOCAL_CONFIG_NAME,
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
          const ref = yield* LocalHyperdriveRef;
          const worker = yield* HyperdriveRefLocalWorker;
          return { ref, worker };
        }),
      );

      // Mode-agnostic observe: the ref resolves the REAL config even under
      // dev, while the worker itself is served locally.
      expect(deployed.ref.hyperdriveId).toBe(created.id);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      // The binding passes through to the `dev` origin.
      const body = (yield* getJsonReady(
        `${deployed.worker.url}/query`,
      )) as QueryBody;
      expect(body.row.sum).toBe(2);
      expect(body.row.db).toBe(databaseName);
      expect(body.host).toBe(origin.host);

      yield* stack.destroy();

      // Destroy never touches the referenced config.
      const survived = yield* hyperdrive.getConfig({
        accountId,
        hyperdriveId: created.id,
      });
      expect(survived.id).toBe(created.id);

      yield* hyperdrive.deleteConfig({ accountId, hyperdriveId: created.id });
    }).pipe(logLevel),
  { timeout: 300_000 },
);
