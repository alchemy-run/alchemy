import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "railway",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.RailwayAuth,
  ),
});
