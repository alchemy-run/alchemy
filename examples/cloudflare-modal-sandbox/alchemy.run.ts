// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Warm } from "./src/Sandbox.ts";

export default Alchemy.Stack(
  "CloudflareModalSandboxExample",
  {
    // Binding hosts act with your Modal token, which works on every plan. On
    // a Team or Enterprise workspace, drop Modal.DeployerHostIdentity to give
    // each host its own scoped service user instead.
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Modal.providers(),
      Modal.DeployerHostIdentity,
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const warm = yield* Warm;
    const api = yield* Api;
    return { url: api.url.as<string>(), image: warm.imageId };
  }),
);
