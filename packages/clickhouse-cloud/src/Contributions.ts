import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "clickhouse-cloud",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.ClickHouseCloudAuth,
  ),
});
