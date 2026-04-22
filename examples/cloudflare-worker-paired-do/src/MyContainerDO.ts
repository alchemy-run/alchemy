/**
 * MyContainerDO — Paired DurableObjectNamespace resource.
 *
 * This is the pattern that triggers issue #72: a SEPARATE, EXPLICIT
 * `DurableObjectNamespace` resource (not inlined into the Container class) with
 * a DIFFERENT LogicalId ("MyContainer" here, vs "MyContainerApp" on the
 * Container). The LogicalId mismatch is mandatory to avoid `sid` collision in
 * `Diff.ts`'s last-write-wins binding dedup — see README.md.
 *
 * The DO body uses `Cloudflare.Container.bind(MyContainer)` to establish the
 * FK linkage from Container app → DO namespace. THIS is where the bug fires:
 * the `bindContainer` call graph pulls `namespaceId` as an `Output<T>`, but the
 * DO's namespace hasn't resolved yet when Container tries to reference it,
 * producing a circular Output dependency. Deploy silently succeeds with the
 * linkage missing (`durableObjects: null` in state); runtime then errors
 * `no container application assigned to this Durable Object namespace`.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MyContainer } from "./MyContainer.ts";

export default class MyContainerDO extends Cloudflare.DurableObjectNamespace<MyContainerDO>()(
  // NOTE: LogicalId "MyContainer" differs from Container's "MyContainerApp".
  // See README — this is the `sid` collision workaround.
  "MyContainer",
  Effect.gen(function* () {
    const myContainer = yield* Cloudflare.Container.bind(MyContainer);

    return Effect.gen(function* () {
      const container = yield* Cloudflare.start(myContainer);

      return {
        hello: () => container.hello(),
        health: () =>
          Effect.gen(function* () {
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(
              HttpClientRequest.get("http://container/health"),
            );
            return yield* response.text;
          }),
        fetch: Effect.gen(function* () {
          const { fetch } = yield* container.getTcpPort(3000);
          const response = yield* fetch(
            HttpClientRequest.get("http://container/"),
          );
          const body = yield* response.text;
          return HttpServerResponse.text(body);
        }),
      };
    });
  }),
) {}
