import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "fly",
  auth: () => import("./AuthProvider.ts").then((module) => module.FlyAuth),
});
