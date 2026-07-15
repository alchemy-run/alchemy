import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Application } from "./Application.ts";

/**
 * Shared scaffolding for AWS Kinesis Analytics v2 (Managed Service for
 * Apache Flink) HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeKinesisAnalyticsHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action list is
 * boilerplate.
 *
 * Every bound operation addresses a single application: the request carries
 * an `ApplicationName` field which the runtime callable injects from the
 * bound {@link Application}, and the deploy-time half grants `actions` on
 * the application's ARN (all `kinesisanalytics:*Application*` actions
 * authorize against the application resource).
 */
export const makeKinesisAnalyticsHttpBinding = <
  I extends { ApplicationName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.KinesisAnalyticsV2.StartApplication`. */
  tag: string;
  /** The distilled operation; `ApplicationName` is injected from the application. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the application ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <App extends Application>(application: App) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const ApplicationName = yield* application.applicationName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${application}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${application.applicationArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${application.LogicalId})`)(function* (
        request?: Omit<I, "ApplicationName">,
      ) {
        return yield* op({
          ...request,
          ApplicationName: yield* ApplicationName,
        } as I);
      });
    });
  });
