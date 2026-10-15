import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "hetzner",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.HetznerAuth,
  ),
});
