import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Cache } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitValkeyExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const cache = yield* Cache;
    const api = yield* Api;

    return {
      url: api.url,
      projectId: cache.projectId,
      region: cache.region,
      instanceId: cache.instanceId,
    };
  }),
);
