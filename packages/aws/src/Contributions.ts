import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "aws",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AwsAuth,
  ),
  stateStores: {
    aws: {
      description: "S3 state store in the profile's AWS account",
      load: Contributions.lazy(
        () => import("./Alchemist/StateStore.ts"),
        (module) => module.stateStore,
      ),
    },
  },
  cli: {
    provider: {
      description: "Manage AWS provider prerequisites",
      load: Contributions.lazy(
        () => import("./Cli.ts"),
        (module) => module.awsCommand,
      ),
    },
  },
  testServices: Contributions.lazy(
    () => import("./Local/TestServices.ts"),
    (module) => module.testServices(),
  ),
});
