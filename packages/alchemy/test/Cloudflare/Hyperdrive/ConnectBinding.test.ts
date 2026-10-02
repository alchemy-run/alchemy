import * as Cloudflare from "@/Cloudflare/index.ts";
import type { Connection } from "@/Cloudflare/Hyperdrive/Connection.ts";
import { Worker, WorkerEnvironment } from "@/Cloudflare/Workers/Worker.ts";
import * as Output from "@/Output";
import { remote, type ProviderMode } from "@/ProviderMode.ts";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { inDev } from "../../test.resources.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const tags = ["unit", "provider:cloudflare:hyperdrive"];

/** The slice of the host Worker that `ConnectBinding` touches at bind time. */
interface RecordingHost {
  readonly Mode: ProviderMode | undefined;
  readonly bind: (
    template: TemplateStringsArray,
    ...args: unknown[]
  ) => (data: unknown) => Effect.Effect<void>;
}

// Worker resolves its host through the resource's Self key.
const WorkerHost = Context.Service<Worker, RecordingHost>(Worker.Self.key);

const accessOrigin = {
  scheme: "postgres" as const,
  host: "db.internal.example.com",
  database: "app",
  user: "app",
  password: Redacted.make("password"),
  accessClientId: Redacted.make("client-id"),
  accessClientSecret: Redacted.make("client-secret"),
};

const devOriginError =
  /Hyperdrive instance Db has an origin that requires Cloudflare Access\. This is not supported in development mode/;

/**
 * Register an Access-protected Hyperdrive (no `dev` origin), let `bind`
 * attach it to a host, then resolve the bind data the way Apply does right
 * before the host reconciles (`Output.evaluate(node.bindings, outputs)`).
 */
const resolveBindData = (
  bind: (connection: Connection) => Effect.Effect<unknown, never, any>,
) =>
  Effect.gen(function* () {
    const connection = yield* Cloudflare.Hyperdrive.Connection("Db", {
      origin: accessOrigin,
    });
    const data = yield* bind(connection);
    return yield* Output.evaluate(data, {
      [connection.FQN]: {
        hyperdriveId: "hyperdrive-id",
        name: "db",
        accountId: "account-id",
        origin: accessOrigin,
        mtls: {},
        dev: undefined,
      },
    });
  }).pipe(
    Stack.make({
      name: "HyperdriveConnectBinding",
      providers: Cloudflare.providers(),
      state: Layer.effect(
        State,
        Effect.sync(() => InMemoryService({})),
      ),
    }),
    Effect.map((stack) => stack.output),
    Effect.provideService(Stage, "test"),
    Effect.scoped,
  );

/** Effect-native Worker path: `Cloudflare.Hyperdrive.Connect(connection)`. */
const viaConnect = (hostMode: ProviderMode | undefined) =>
  resolveBindData((connection) =>
    Effect.gen(function* () {
      const recorded: unknown[] = [];
      const host: RecordingHost = {
        Mode: hostMode,
        bind: () => (data) => Effect.sync(() => void recorded.push(data)),
      };
      const connect = yield* Cloudflare.Hyperdrive.Connect.pipe(
        Effect.provide(Cloudflare.Hyperdrive.ConnectBinding),
        Effect.provideService(WorkerHost, host),
        Effect.provideService(WorkerEnvironment, {}),
      );
      yield* connect(connection);
      expect(recorded).toHaveLength(1);
      return recorded[0];
    }),
  );

/** Async Worker path: `env: { DB: connection }`. */
const viaAsyncEnv = (hostMode: ProviderMode | undefined) =>
  resolveBindData((connection) =>
    Effect.gen(function* () {
      const worker = yield* Cloudflare.Worker("Api", {
        script: `export default { fetch: () => new Response("ok") };`,
        env: { DB: connection },
      }).pipe(remote(hostMode === "live"));
      const stack = yield* Stack.Stack;
      const row = (stack.bindings[worker.FQN] ?? []).find(
        (row) => row.sid === "DB",
      );
      expect(row).toBeDefined();
      return row?.data;
    }),
  );

const paths = { Connect: viaConnect, "async env": viaAsyncEnv };

for (const [path, bindVia] of Object.entries(paths)) {
  test(
    `${path}: deploy binds an Access-protected origin without \`dev\``,
    Effect.gen(function* () {
      const data = yield* bindVia(undefined);
      expect(data).toMatchObject({
        bindings: [{ type: "hyperdrive", id: "hyperdrive-id" }],
      });
      // The dev origin channel is read only by the local worker provider.
      expect(data).not.toHaveProperty("hyperdrives.hyperdrive-id");
    }),
    { tags },
  );

  test(
    `${path}: a remote() worker in dev binds an Access-protected origin without \`dev\``,
    inDev(
      Effect.gen(function* () {
        const data = yield* bindVia("live");
        expect(data).not.toHaveProperty("hyperdrives.hyperdrive-id");
      }),
    ),
    { tags },
  );

  test(
    `${path}: a local worker in dev still rejects an Access-protected origin without \`dev\``,
    inDev(
      Effect.gen(function* () {
        const exit = yield* bindVia(undefined).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toMatch(devOriginError);
        }
      }),
    ),
    { tags },
  );
}
