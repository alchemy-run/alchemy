import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "neon",
  auth: () => import("./AuthProvider.ts").then((module) => module.NeonAuth),
});
