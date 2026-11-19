// alchemy.run.ts
import * as Modal from "@alchemy.run/modal";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import Status from "./src/Status.ts";

export default Alchemy.Stack(
  "ModalFunctionsExample",
  {
    // Binding hosts act with your Modal token, which works on every plan. On
    // a Team or Enterprise workspace, drop Modal.DeployerHostIdentity to give
    // each host its own scoped service user instead.
    providers: Layer.mergeAll(Modal.providers(), Modal.DeployerHostIdentity),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const status = yield* Status;
    return { api: api.url, status: status.url };
  }),
);
