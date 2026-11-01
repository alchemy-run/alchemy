import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Box } from "./src/server.ts";

export default Alchemy.Stack(
  "StackitServiceExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { server } = yield* Box;
    const api = yield* Api;

    return {
      url: api.url,
      unitName: api.unitName,
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
    };
  }),
);
