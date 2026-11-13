# @alchemy.run/starburst-galaxy

[Starburst Galaxy](https://www.starburst.io/platform/starburst-galaxy/) for [Alchemy](https://alchemy.run). Declare managed Trino clusters, the catalogs they query, and who may query them, next to the databases they read.

```sh
npm install alchemy @alchemy.run/starburst-galaxy effect
```

A PostgreSQL catalog, a cluster that suspends when idle, and a service account that may query one schema:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Analytics",
  {
    providers: StarburstGalaxy.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const password = yield* Config.Redacted("ORDERS_READER_PASSWORD");
    const orders = yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Orders", {
      endpoint: "orders.example.com",
      databaseName: "orders",
      username: "galaxy_reader",
      password,
    });

    const cluster = yield* StarburstGalaxy.Cluster.Cluster("Analytics", {
      cloudRegionId: "aws-us-east1",
      catalogs: [orders.catalogId],
      autoSuspend: "5 minutes",
    });

    const reporting = yield* StarburstGalaxy.Role.Role("Reporting", {});
    yield* StarburstGalaxy.Role.RolePrivilege("ReportingUseCluster", {
      role: reporting.roleId,
      privilege: "UseCluster",
      entity: { kind: "Cluster", clusterId: cluster.clusterId },
    });
    yield* StarburstGalaxy.Role.RolePrivilege("ReportingSelect", {
      role: reporting.roleId,
      privilege: "Select",
      entity: { kind: "Table", catalogId: orders.catalogId, schemaName: "public", tableName: "*" },
    });

    const account = yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Reporter", { role: reporting.roleId });
    const login = yield* StarburstGalaxy.ServiceAccount.ServiceAccountPassword("ReporterPassword", {
      serviceAccount: account.serviceAccountId,
    });

    return { trinoUri: cluster.trinoUri, user: account.userName, password: login.trinoPassword };
  }),
);
```

Connect any Trino client to `trinoUri` as `user` with `password`.

Beyond catalogs, clusters and roles, the provider covers governance (column masks, row filters, tags, policies), data products, data quality checks and schedules, catalog metadata, SQL jobs and streaming ingestion, plus bindings that call Galaxy from a Worker or any other host.

## Learn more

- [Starburst Galaxy on alchemy.run](https://alchemy.run/starburst-galaxy)
- [Setup](https://alchemy.run/starburst-galaxy/setup)
- [Tutorial](https://alchemy.run/starburst-galaxy/tutorial)
- [Credentials & bindings](https://alchemy.run/starburst-galaxy/credentials)
