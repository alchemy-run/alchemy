import * as Lambda from "@alchemy.run/effect-aws/lambda";
import * as SQS from "@alchemy.run/effect-aws/sqs";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { Message, Messages } from "./messages.ts";

export * from "./messages.ts";

// resource declarations (stateless)
export class Api extends Lambda.Function("api", {
  url: true,
}) {}

// biz logic declaration
export const api = Api.serve(
  Effect.fn(function* (req) {
    const msg = yield* S.validate(Message)(req.body);
    yield* SQS.sendMessage(Messages, msg).pipe(
      Effect.catchAll(() => Effect.void),
    );
    return {
      statusCode: 200,
      body: JSON.stringify(null),
    };
  }),
);

// runtime handler
export default api.pipe(SQS.clientFromEnv(), Lambda.toHandler);
