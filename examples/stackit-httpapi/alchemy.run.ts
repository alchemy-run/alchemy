import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Tasks } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitHttpApiExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const api = yield* Api;

    return {
      url: api.url,
      functionId: api.functionId,
      projectId: api.projectId,
      region: api.region,
      bucketName: tasks.bucketName,
    };
  }),
);
