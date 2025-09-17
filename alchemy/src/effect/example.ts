import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as App from "./app.ts";
import * as Credentials from "./aws/credentials.ts";
import * as Lambda from "./aws/function.ts";
import * as AWS from "./aws/index.ts";
import * as Queue from "./aws/queue.ts";
import * as Region from "./aws/region.ts";
import { plan } from "./plan.ts";
import * as Policy from "./policy.ts";

// TODO: Michael cares about nested naming

// resource declarations (stateless)
export class Api extends Lambda.Tag("api", {
  url: true,
  main: import.meta.file,
}) {}

export const Message = S.Struct({
  id: S.Int,
  value: S.String,
});

export class Messages extends Queue.Tag("messages", {
  fifo: true,
  message: Message,
}) {}

// lazy implementation declaration
const api = Api.serve((req) =>
  Effect.gen(function* () {
    const msg = yield* S.validate(Message)(yield* req.json);
    yield* Queue.send(Messages, msg);
    return yield* HttpServerResponse.json({
      sent: true,
    });
  }),
);

// lazy handler definition
export default api.pipe(Effect.provide(Queue.clientFromEnv), Lambda.toHandler);

const app = App.of({ name: "my-iae-app", stage: "dev" });

const aws = AWS.defaultProviders.pipe(
  Layer.provide(Region.fromEnv),
  Layer.provide(Credentials.fromChain),
);

export const infra = Lambda.make(
  Api,
  api,
  Policy.of(Queue.SendMessage(Messages)),
);

const updatePlan = plan(infra);

const applied = updatePlan.pipe(Effect.provide(aws), Effect.provide(app));
// console.log({
//   url: plan.resources.worker2.url,
// });

// export default defineApp({
//   name: "my-app",
//   stage: "my-stage",
//   providers: {
//     aws: {
//       region: "us-east-1",
//     },
//   },
//   resources: {},
// });

// console.log({
//   // how do i get the value?
//   url: infra.url,
// });

// Bind<Lambda, SQS>
// Bind<Worker, SQS>

// export const handler = Function.handler(Api);

// export const handler = Function.handler(Api).pipe(
//   Effect.provide(Credentials.fromEnv),
// );

// const consume = Queue.consume(Messages, (batch) =>
//   Effect.gen(function* () {
//     //
//   }),
// );
