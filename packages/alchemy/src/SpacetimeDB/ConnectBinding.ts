import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { Resource, ResourceLike } from "../Resource.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { Connect, connectEnvKeys, type ConnectClient } from "./Connect.ts";
import { SpacetimeDBCredentials } from "./Credentials.ts";
import type { Database } from "./Database.ts";

type ConnectEnvBindingHost = Resource<
  "AWS.Lambda.Function",
  object | undefined,
  object,
  { env?: Record<string, unknown> }
>;

type ConnectWorkerTextBinding =
  | {
      type: "plain_text";
      name: string;
      text: string;
    }
  | {
      type: "secret_text";
      name: string;
      text: string;
    };

type ConnectWorkerBindingHost = Resource<
  "Cloudflare.Worker",
  object | undefined,
  object,
  { bindings?: ConnectWorkerTextBinding[] }
>;

const supportsConnectEnvBinding = (
  host: ResourceLike,
): host is ConnectEnvBindingHost => host.Type === "AWS.Lambda.Function";

const supportsConnectWorkerBinding = (
  host: ResourceLike,
): host is ConnectWorkerBindingHost => host.Type === "Cloudflare.Worker";

const emptyStringFor = (value: unknown): Output.Output<string> =>
  Output.map(
    value as Output.Output<string | undefined>,
    (v: string | undefined) => v ?? "",
  ) as unknown as Output.Output<string>;

const redactedFromMaybeString = (
  value: unknown,
): Redacted.Redacted<string> | undefined => {
  if (typeof value !== "string") return undefined;
  return Redacted.make(value);
};

const tokenFromOption = (
  opt: Option.Option<unknown>,
): Redacted.Redacted<string> | undefined =>
  Option.isSome(opt)
    ? redactedFromMaybeString(
        (opt.value as { token?: Redacted.Redacted<string> })?.token,
      )
    : undefined;

const connectEnv = (
  database: Database,
  token: Redacted.Redacted<string> | undefined,
): Record<string, unknown> => {
  const keys = connectEnvKeys(database);
  return {
    [keys.uri]: database.uri,
    [keys.databaseName]: database.databaseName,
    [keys.databaseIdentity]: database.databaseIdentity,
    [keys.host]: database.host,
    [keys.dashboardUrl]: emptyStringFor(database.dashboardUrl),
    [keys.token]: token ? Redacted.value(token) : "",
  };
};

const workerBindingValue = (
  name: string,
  value: Output.Output<string>,
): Output.Output<ConnectWorkerTextBinding> =>
  value.pipe(
    Output.map((text) => ({
      type: "plain_text" as const,
      name,
      text,
    })),
  );

const connectWorkerBindings = (
  database: Database,
  token: Redacted.Redacted<string> | undefined,
): Output.Output<ConnectWorkerTextBinding>[] => {
  const keys = connectEnvKeys(database);
  return [
    workerBindingValue(keys.uri, database.uri),
    workerBindingValue(keys.databaseName, database.databaseName),
    workerBindingValue(keys.databaseIdentity, database.databaseIdentity),
    workerBindingValue(keys.host, database.host),
    workerBindingValue(
      keys.dashboardUrl,
      emptyStringFor(database.dashboardUrl),
    ),
    // Token binding: when present, emit a secret_text entry. When absent,
    // emit an empty plain_text so the count is stable (the Worker provider
    // filters empty `text` values out at upload time).
    Output.of(
      token
        ? ({
            type: "secret_text" as const,
            name: keys.token,
            text: Redacted.value(token),
          } as unknown as never)
        : ({
            type: "plain_text" as const,
            name: keys.token,
            text: "",
          } as unknown as never),
    ),
  ];
};

const runtimeOutput = <A>(
  output: Output.Output<A>,
): Effect.Effect<A, never, RuntimeContext> =>
  output as unknown as Effect.Effect<A, never, RuntimeContext>;

/**
 * Implementation layer for {@link Connect}. Provide it on the host
 * Function/Worker Effect.
 */
export const ConnectBinding = Layer.effect(
  Connect,
  Effect.gen(function* () {
    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        const creds = yield* Effect.serviceOption(SpacetimeDBCredentials);
        const token = tokenFromOption(creds);

        if (supportsConnectEnvBinding(host)) {
          yield* host.bind`${database}`({
            env: connectEnv(database, token),
          });
        } else if (supportsConnectWorkerBinding(host)) {
          yield* host.bind`${database}`({
            bindings: connectWorkerBindings(database, token),
          });
        } else {
          return yield* Effect.die(
            new Error(
              `SpacetimeDB.Connect supports AWS.Lambda.Function and Cloudflare.Worker runtimes, got '${host.Type}'`,
            ),
          );
        }
        return {
          uri: runtimeOutput(database.uri),
          databaseName: runtimeOutput(database.databaseName),
          databaseIdentity: runtimeOutput(database.databaseIdentity),
          host: runtimeOutput(database.host),
          dashboardUrl: runtimeOutput(emptyStringFor(database.dashboardUrl)),
          token: Effect.succeed(token),
        } satisfies ConnectClient;
      }

      const _keys = connectEnvKeys(database);
      return {
        uri: runtimeOutput(database.uri),
        databaseName: runtimeOutput(database.databaseName),
        databaseIdentity: runtimeOutput(database.databaseIdentity),
        host: runtimeOutput(database.host),
        dashboardUrl: runtimeOutput(emptyStringFor(database.dashboardUrl)),
        token: Effect.succeed(undefined),
      } satisfies ConnectClient;
    });
  }),
);
