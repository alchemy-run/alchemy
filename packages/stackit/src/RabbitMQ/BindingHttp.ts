import { ConfigError } from "@distilled.cloud/core/errors";
import {
  RabbitMQManagementCredentials,
  rabbitmqManagementCredentialsOf,
} from "@distilled.cloud/stackit/Credentials";
import type { RabbitMQManagementOpContext } from "@distilled.cloud/stackit/Protocol";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import { toRedacted } from "../internal/dataServices.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { Credential } from "./Credential.ts";
import type { Instance } from "./Instance.ts";
import { vhostOfUri } from "./internal.ts";

/**
 * Shared HTTP scaffolding for RabbitMQ bindings.
 * NOT exported from index.ts.
 *
 * Two APIs, two kinds of access:
 *
 * - STACKIT's API takes a STACKIT identity, through `StackitBindings`. Its grants
 *   list exactly the permissions an operation needs, the `x-stackit-authorization`
 *   actions in the service's API spec, on the project holding the instance. STACKIT
 *   binds roles on nothing narrower.
 * - The broker's own management API takes the Basic auth of a `Credential`. These
 *   bindings grant no STACKIT role and create no service account: they read the
 *   credential's attributes, which reach the host through its `RuntimeContext`.
 */

/** Build a binding over one STACKIT operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.RabbitMQ.GetInstance`. */
  tag: string;
  /** The `x-stackit-authorization` action of the operation. */
  permission: string;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/** A secret's text, for a broker call. A host's env can hand one back unwrapped. */
const revealed = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** A request on the broker: the virtual host defaults to the credential's. */
export type BrokerRequest<I extends { vhost: string }> = Omit<I, "vhost"> & {
  /**
   * Virtual host.
   * @default the one in the credential's AMQP URI, or `/` when it names none
   */
  readonly vhost?: string;
};

/** Calls `rabbitmq_management` operations with a bound credential. */
export interface BrokerCaller {
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, RabbitMQManagementOpContext>,
    request: I,
  ): Effect.Effect<A, E>;
  /** The virtual host the credential's AMQP URI points at. */
  readonly vhost: Effect.Effect<string>;
}

/**
 * Read a credential's broker access. Its attributes are resolved from the host's
 * environment when a call runs, and the password stays `Redacted`. A credential the
 * API gave no management address fails each call with `ConfigError`.
 */
export const brokerCaller = Effect.fn(function* (credential: Credential) {
  const httpApiUri = yield* credential.httpApiUri;
  const username = yield* credential.username;
  const password = yield* credential.password;
  const uri = yield* credential.uri;
  const credentials = Effect.gen(function* () {
    const address = yield* httpApiUri;
    if (address === undefined) {
      return yield* new ConfigError({
        message: `STACKIT RabbitMQ credential ${credential.LogicalId} has no management HTTP API address`,
      });
    }
    const user = yield* username;
    const secret = yield* password;
    return yield* rabbitmqManagementCredentialsOf({
      httpApiUri: revealed(address),
      username: user,
      password: toRedacted(secret),
    });
  });
  const call = <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, RabbitMQManagementOpContext>,
    request: I,
  ): Effect.Effect<A, E> =>
    operation(request).pipe(
      Effect.provideService(RabbitMQManagementCredentials, credentials),
      Effect.provide(FetchHttpClient.layer),
    );
  const vhost = Effect.map(uri, (value) => vhostOfUri(revealed(value)));
  return Object.assign(call, { vhost }) as BrokerCaller;
});

/** Build a binding over one broker-wide operation: `<Op>Http.ts` is one call to it. */
export const makeBrokerHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.RabbitMQ.GetOverview`. */
  tag: string;
  /** The distilled operation. */
  operation: (input: I) => Effect.Effect<A, E, RabbitMQManagementOpContext>;
}) =>
  Effect.fn(function* (credential: Credential) {
    const call = yield* brokerCaller(credential);
    return Effect.fn(`${options.tag}(${credential.LogicalId})`)(function* (request: I) {
      return yield* call(options.operation, request);
    });
  });

/**
 * Build a binding over one operation in a virtual host: `<Op>Http.ts` is one call to
 * it. The credential's virtual host is the default.
 */
export const makeVhostHttpBinding = <I extends { vhost: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.RabbitMQ.GetQueue`. */
  tag: string;
  /** The distilled operation. */
  operation: (input: I) => Effect.Effect<A, E, RabbitMQManagementOpContext>;
}) =>
  Effect.fn(function* (credential: Credential) {
    const call = yield* brokerCaller(credential);
    return Effect.fn(`${options.tag}(${credential.LogicalId})`)(function* (
      request: BrokerRequest<I>,
    ) {
      const vhost = request.vhost ?? (yield* call.vhost);
      // The compiler can't prove `Omit<I, "vhost">` plus `vhost` is `I`.
      return yield* call(options.operation, { ...request, vhost } as unknown as I);
    });
  });
