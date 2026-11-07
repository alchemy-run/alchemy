import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "daytona",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.DaytonaAuth,
  ),
});
