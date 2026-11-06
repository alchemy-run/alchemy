// alchemy.run.ts
import * as Modal from "@alchemy.run/modal";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import Status from "./src/Status.ts";

export default Alchemy.Stack(
  "ModalFunctionsExample",
  { providers: Modal.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    const status = yield* Status;
    return { api: api.url, status: status.url };
  }),
);
