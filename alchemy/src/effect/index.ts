import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Lambda from "./aws/function.ts";
import * as Queue from "./aws/queue.ts";
import * as Policy from "./policy.ts";

export class Api extends Lambda.Tag("api", {
  url: true,
}) {}

export class Messages extends Queue.Tag("messages", {
  fifo: true,
  message: S.Struct({
    id: S.String,
    value: S.String,
  }),
}) {}

const consume = Queue.consume(Messages, (batch) =>
  Effect.gen(function* () {
    //
  }),
);

const api = Api.serve((req: any, ctx: any) =>
  Effect.gen(function* () {
    yield* Lambda.invoke(Api, {
      id: "1",
      value: "1",
    }).pipe(Effect.catchAll(() => Effect.void));

    return null;
  }),
);

export const handler = api.pipe(
  Effect.provide(
    Layer.mergeAll(
      Lambda.clientFromEnv,
      Lambda.arn(Api),
      // TODO(sam): should not be here (infra phantom)
    ),
  ),
  Lambda.toHandler,
);

export const apiResource = Lambda.make(Api, api, Policy.of(Lambda.Invoke(Api)));

const infra = await apiResource.pipe(
  Effect.provide(Lambda.lifecycleFromEnv),
  Effect.runPromise,
);

await fetch(infra.functionUrl);

// export const handler = Function.handler(Api);

// export const handler = Function.handler(Api).pipe(
//   Effect.provide(Credentials.fromEnv),
// );
