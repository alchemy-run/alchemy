/**
 * Contributes the test forwarder (see `IngressForwarder.ts`) as an ingress
 * adapter, so a test that runs under the real `alchemy dev` sidecar resolves it
 * the way it would resolve an installed router. Declared in this package's
 * `package.json` under `alchemy.contributes`.
 */
import * as Contributions from "alchemy/Contributions";
import { FORWARDER_TYPE } from "./IngressForwarder.ts";

export default Contributions.make({
  name: "alchemy-test",
  ingress: {
    [FORWARDER_TYPE]: Contributions.lazy(
      () => import("./IngressForwarder.ts"),
      (module) => module.sharedFactory,
    ),
  },
});
