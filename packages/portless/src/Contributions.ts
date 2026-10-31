import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "portless",
  devTrust: Contributions.lazy(
    () => import("./internal/DevTrust.ts"),
    (module) => module.devTrust,
  ),
  ingress: {
    portless: Contributions.lazy(
      () => import("./internal/IngressAdapter.ts"),
      (module) => module.factory,
    ),
  },
});
