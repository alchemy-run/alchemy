import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "railway",
  auth: () => import("./AuthProvider.ts").then((module) => module.RailwayAuth),
});
