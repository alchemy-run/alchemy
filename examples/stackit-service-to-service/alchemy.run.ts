import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Gateway from "./src/Gateway.ts";
import { Quotes } from "./src/Quotes.ts";

export default Alchemy.Stack(
  "StackitServiceToServiceExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const quotes = yield* Quotes;
    const gateway = yield* Gateway;

    return {
      url: gateway.url,
      quotesUrl: quotes.url,
      projectId: gateway.projectId,
      gatewayId: gateway.functionId,
      quotesId: quotes.functionId,
    };
  }),
);
