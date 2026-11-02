import type * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import {
  RabbitMQManagementCredentials,
  rabbitmqManagementCredentialsOf,
} from "@distilled.cloud/stackit/Credentials";
import type { RabbitMQManagementOpContext } from "@distilled.cloud/stackit/Protocol";
import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT RabbitMQ suites.
 *
 * Instances are billed per started hour by plan (about EUR 0.12 for a single node, from
 * the catalog's price notes), so every suite that creates one is gated behind the
 * provider-wide slow flag `STACKIT_TEST_SLOW`. A full run holds about seven instances for
 * an hour each, so about EUR 0.85.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/**
 * The version and smallest plan. No source lists them for certain: a wrong name fails
 * the first deploy with `DataServicePlanNotFound`, which lists the project's choices.
 */
export const VERSION = "4.1";
export const PLAN = "stackit-rabbitmq-2.4.10-single";

/** Reserved documentation range: nothing can connect, which these suites don't need. */
export const CLOSED_ACL = "192.0.2.1/32";

/** Anyone can connect: the bindings suites reach the broker from a Worker's egress IPs. */
export const OPEN_ACL = "0.0.0.0/0";

export const instanceProps = (acl: string = CLOSED_ACL) =>
  ({
    version: VERSION,
    planName: PLAN,
    acl: [acl],
  }) satisfies Stackit.RabbitMQ.InstanceProps;

/** The instance, or `"gone"` on the typed not-found and gone errors. */
export const observeInstance = (projectId: string, regionId: string, instanceId: string) =>
  rabbitmq
    .getInstance({ projectId, regionId, instanceId })
    .pipe(Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.succeed("gone" as const)));

/** The credential, or `"gone"` on the typed not-found and gone errors. */
export const observeCredential = (
  projectId: string,
  regionId: string,
  instanceId: string,
  credentialsId: string,
) =>
  rabbitmq
    .getCredentials({ projectId, regionId, instanceId, credentialsId })
    .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.succeed("gone" as const)));

/** Bounded check that an observation reports `"gone"`. */
export const expectGone = <A, E, R>(observe: Effect.Effect<A | "gone", E, R>) =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 12,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

/** What an out-of-band call on the broker needs of a credential. */
export interface BrokerAccess {
  readonly httpApiUri: Redacted.Redacted<string> | undefined;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}

/** Run a broker operation out of band, with a stack's own credential. */
export const onBroker = <A, E>(
  access: BrokerAccess,
  operation: Effect.Effect<A, E, RabbitMQManagementOpContext>,
) =>
  operation.pipe(
    Effect.provideService(
      RabbitMQManagementCredentials,
      rabbitmqManagementCredentialsOf({
        httpApiUri: Redacted.value(access.httpApiUri!),
        username: access.username,
        password: access.password,
      }),
    ),
  );
