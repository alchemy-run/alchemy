import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "aws",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AwsAuth,
  ),
  stateStore: {
    description: "S3 state store in the profile's AWS account",
    load: Plugin.lazy(
      () => import("./Alchemist/StateStore.ts"),
      (module) => module.stateStore,
    ),
  },
  cli: {
    provider: {
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
