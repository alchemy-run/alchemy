import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "aws",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AwsAuth,
  ),
  stateStores: {
    aws: {
      description: "S3 state store in the profile's AWS account",
      layer: Plugin.lazy(
        () => import("./StateStore/State.ts"),
        (module) =>
          ({ name }) =>
            module.state({ name }),
      ),
      lifecycle: Plugin.lazy(
        () => import("./Alchemist/StateStore.ts"),
        (module) => module.lifecycle,
      ),
    },
  },
  cli: {
    provider: {
      name: "aws",
      description: "Manage AWS provider prerequisites",
      load: Plugin.lazy(
        () => import("./Cli.ts"),
        (module) => module.awsCommand,
      ),
    },
  },
  testServices: Plugin.lazy(
    () => import("./Local/TestServices.ts"),
    (module) => module.testServices(),
  ),
});
