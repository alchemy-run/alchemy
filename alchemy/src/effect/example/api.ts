import type { LambdaFunctionURLResult } from "aws-lambda";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as Lambda from "../aws/function.ts";
import * as Queue from "../aws/queue.ts";
import * as Policy from "../policy.ts";
import { Message, Messages } from "./messages.ts";

// TODO: Michael cares about nested naming

// resource declarations (stateless)
export class Api extends Lambda.Tag("api", {
  url: true,
}) {}

// biz logic declaration
export const api = Api.serve(
  Effect.fn(function* (req) {
    const msg = yield* S.validate(Message)(req.body);
    yield* Queue.send(Messages, msg).pipe(Effect.catchAll(() => Effect.void));
    return {
      statusCode: 200,
      body: JSON.stringify(null),
    } satisfies LambdaFunctionURLResult;
  }),
);

// runtime handler
export default api.pipe(Effect.provide(Queue.clientFromEnv), Lambda.toHandler);

// infrastructure (as effect)
export class ApiLambda extends Lambda.make(api, {
  main: import.meta.file,
  policy: Policy.of(Queue.SendMessage(Messages)),
}) {}
