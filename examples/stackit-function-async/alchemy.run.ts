import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { Files, Notes } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitFunctionAsyncExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const files = yield* Files;
    const notes = yield* Notes;

    return {
      url: notes.url,
      functionId: notes.functionId,
      projectId: notes.projectId,
      region: notes.region,
      bucketName: files.bucketName,
    };
  }),
);
