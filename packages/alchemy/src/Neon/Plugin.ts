import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "neon",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.NeonAuth,
  ),
});
