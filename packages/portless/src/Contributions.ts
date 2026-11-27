import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "portless",
  devTrust: Contributions.lazy(
    () => import("./internal/DevTrust.ts"),
    (module) => module.devTrust,
  ),
});
