import * as oam from "@distilled.cloud/aws/oam";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Sink } from "./Sink.ts";

/**
 * Request for {@link ListAttachedLinks} — the bound sink's ARN is injected
 * as `SinkIdentifier`, so only pagination knobs remain.
 */
export interface ListAttachedLinksRequest extends Omit<
  oam.ListAttachedLinksInput,
  "SinkIdentifier"
> {}

/**
 * Runtime binding for `oam:ListAttachedLinks` — enumerate the source-account
 * links attached to the bound monitoring-account {@link Sink} (each item
 * carries the link's ARN, resolved label, and shared resource types). The
 * sink's ARN is injected automatically.
 *
 * Provide `AWS.OAM.ListAttachedLinksHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Listing Attached Links
 * **Example:** Enumerate the source accounts connected to a sink
 * ```typescript
 * // init — grants oam:ListAttachedLinks on the sink
 * const listAttachedLinks = yield* AWS.OAM.ListAttachedLinks(sink);
 *
 * // runtime
 * const { Items } = yield* listAttachedLinks();
 * for (const item of Items) {
 *   yield* Effect.log(`${item.Label} shares ${item.ResourceTypes?.join(", ")}`);
 * }
 * ```
 *
 * @binding
 */
export interface ListAttachedLinks extends Binding.Service<
  ListAttachedLinks,
  "AWS.OAM.ListAttachedLinks",
  (
    sink: Sink,
  ) => Effect.Effect<
    (
      request?: ListAttachedLinksRequest,
    ) => Effect.Effect<oam.ListAttachedLinksOutput, oam.ListAttachedLinksError>
  >
> {}

export const ListAttachedLinks = Binding.Service<ListAttachedLinks>("AWS.OAM.ListAttachedLinks");

/**
 * HTTP implementation of {@link ListAttachedLinks}: grants
 * `oam:ListAttachedLinks` on the bound sink and calls the OAM HTTP API with
 * the function's IAM credentials, injecting the sink's ARN as the
 * `SinkIdentifier`.
 */
export const ListAttachedLinksHttp = Layer.effect(
  ListAttachedLinks,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listAttachedLinks = yield* AWSBindings.withCredentials(oam.listAttachedLinks);

    return Effect.fn(function* (sink: Sink) {
      const SinkIdentifier = yield* sink.sinkArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.OAM.ListAttachedLinks(${sink})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["oam:ListAttachedLinks"],
              Resource: [sink.sinkArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.OAM.ListAttachedLinks(${sink.LogicalId})`)(function* (
        request?: ListAttachedLinksRequest,
      ) {
        return yield* listAttachedLinks({
          ...request,
          SinkIdentifier: yield* SinkIdentifier,
        });
      });
    });
  }),
);
