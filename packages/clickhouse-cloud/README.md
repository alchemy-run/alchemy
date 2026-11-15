# @alchemy.run/clickhouse-cloud

[ClickHouse Cloud](https://clickhouse.com/cloud) for [Alchemy](https://alchemy.run). Declare ClickHouse services, their backups, API keys and roles next to the code that queries them.

```sh
npm install alchemy @alchemy.run/clickhouse-cloud effect
```

A service that idles when unused, backed up twice a day, and a key that can only read it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Analytics",
  {
    providers: ClickHouseCloud.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
      provider: "aws",
      region: "us-east-1",
      ipAccessList: [{ source: "0.0.0.0/0", description: "anywhere" }],
      idleScaling: true,
      idleTimeoutMinutes: 5,
    });

    yield* ClickHouseCloud.Backup.BackupConfiguration("AnalyticsBackups", {
      serviceId: analytics.serviceId,
      backupPeriodInHours: 12,
    });

    const viewer = yield* ClickHouseCloud.RoleManagement.Role("AnalyticsViewer", {
      policies: [
        {
          allowDeny: "ALLOW",
          permissions: ["control-plane:service:view"],
          resources: [Output.interpolate`instance/${analytics.serviceId}`],
        },
      ],
    });
    const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Dashboards", {
      assignedRoleIds: [viewer.roleId],
    });

    return { url: analytics.httpsUrl, keyId: key.keyId };
  }),
);
```

Run `alchemy profile edit --add ClickHouseCloud` to store an API key, or set `CLICKHOUSE_CLOUD_API_KEY_ID` and `CLICKHOUSE_CLOUD_API_KEY_SECRET`. See the [ClickHouse Cloud docs](https://alchemy.run/clickhouse-cloud) for setup, bindings and the full API reference.
