import * as Axiom from "alchemy/Axiom";
import { Stack } from "alchemy/Stack";

/**
 * `${stage} alchemy CLI overview` — a single dashboard composing the
 * same insights exposed as `Axiom.View`s in `./Views.ts`, laid out on
 * a 12-column grid.
 *
 * Layout (rows top-to-bottom, all in 12 cols):
 *
 * 1. Active users (7d) | CLI invocations (24h) | Active users / hour
 * 2. Deploy/destroy latency p50/p95 | CLI invocations by command/status
 * 3. Top resources by op count | Resource latency p95 by type/op
 * 4. Active users by version | Resource error rate
 * 5. State store deploy success vs error | State store deploy error rate
 *
 * All queries target `${stage}-traces` — Axiom's metrics datasets
 * cannot be queried via APL, but every metric we emit has an
 * equivalent span (`cli.<command>`, `provider.<op>`).
 */
export const CliOverviewDashboard = Axiom.Dashboard(
  "CliOverview",
  Stack.useSync(({ stage }) => {
    const traces = `${stage}-traces`;

    const charts: Axiom.Chart[] = [
      {
        id: "active-users-7d",
        name: "Active users",
        type: "Statistic",
        query: {
          apl: `
            ['${traces}']
            | extend uid=tostring(['resource.custom']['alchemy.user.id'])
            | summarize users=dcount(uid)
          `,
        },
      },
      {
        id: "cli-invocations-24h",
        name: "CLI invocations",
        type: "Statistic",
        query: {
          apl: `
            ['${traces}']
            | where name startswith "cli."
            | summarize total=count()
          `,
        },
      },
      {
        id: "active-users-hourly",
        name: "Active users / hour",
        type: "TimeSeries",
        query: {
          apl: `
            ['${traces}']
            | extend uid=tostring(['resource.custom']['alchemy.user.id'])
            | summarize users=dcount(uid) by bin_auto(_time)
            | order by _time asc
          `,
        },
      },
      {
        id: "deploy-destroy-latency",
        name: "Deploy / destroy latency",
        type: "TimeSeries",
        query: {
          apl: `
            ['${traces}']
            | where name in ("cli.deploy", "cli.destroy")
            | summarize p50=percentile(duration, 50),
                        p95=percentile(duration, 95)
                by name, bin_auto(_time)
            | order by _time asc
          `,
        },
      },
      {
        id: "cli-invocations-by-command",
        name: "CLI invocations by command / status",
        type: "TimeSeries",
        query: {
          apl: `
            ['${traces}']
            | where name startswith "cli."
            | extend command=extract("cli\\\\.(.+)", 1, name),
                     status=iff(tobool(['error']), "error", "success")
            | summarize count=count() by command, status, bin_auto(_time)
            | order by _time asc
          `,
        },
      },
      {
        id: "top-resources",
        name: "Top resources by op count",
        type: "Table",
        query: {
          apl: `
            ['${traces}']
            | where name startswith "provider."
            | extend rt=tostring(['attributes.custom']['alchemy.resource.type']),
                     op=tostring(['attributes.custom']['alchemy.resource.op'])
            | summarize ops=count() by rt, op
            | order by ops desc
            | take 50
          `,
        },
      },
      {
        id: "resource-latency",
        name: "Resource latency p95 (provider.<op>)",
        type: "Table",
        query: {
          apl: `
            ['${traces}']
            | where name startswith "provider."
            | extend rt=tostring(['attributes.custom']['alchemy.resource.type']),
                     op=tostring(['attributes.custom']['alchemy.resource.op'])
            | summarize p50=percentile(duration, 50),
                        p95=percentile(duration, 95),
                        count=count()
                by rt, op
            | order by p95 desc
            | take 50
          `,
        },
      },
      {
        id: "active-users-by-version",
        name: "Active users by alchemy version",
        type: "Table",
        query: {
          apl: `
            ['${traces}']
            | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                     version=tostring(['resource.custom']['alchemy.version'])
            | summarize users=dcount(uid) by version
            | order by users desc
          `,
        },
      },
      {
        id: "state-store-deploys",
        name: "State store deploys (success vs error)",
        type: "TimeSeries",
        query: {
          apl: `
            ['${traces}']
            | where name == "state_store.deploy"
            | extend status=iff(tobool(['error']), "error", "success")
            | summarize count=count() by status, bin_auto(_time)
            | order by _time asc
          `,
        },
      },
      {
        id: "state-store-error-rate",
        name: "State store deploy error rate (%)",
        type: "TimeSeries",
        query: {
          apl: `
            ['${traces}']
            | where name == "state_store.deploy"
            | extend is_error=toint(tobool(['error']))
            | summarize total=count(), errors=sum(is_error) by bin_auto(_time)
            | extend error_rate_pct=todouble(errors) * 100.0 / todouble(total)
            | project _time, error_rate_pct
            | order by _time asc
          `,
        },
      },
      {
        id: "resource-error-rate",
        name: "Resource error rate",
        type: "TimeSeries",
        query: {
          apl: `
            ['${traces}']
            | where name startswith "provider."
            | extend rt=tostring(['attributes.custom']['alchemy.resource.type']),
                     status=iff(tobool(['error']), "error", "success")
            | summarize total=count() by rt, status, bin_auto(_time)
            | order by _time asc
          `,
        },
      },
    ];

    const layout: Axiom.LayoutCell[] = [
      // Row 1
      { i: "active-users-7d", x: 0, y: 0, w: 3, h: 4 },
      { i: "cli-invocations-24h", x: 3, y: 0, w: 3, h: 4 },
      { i: "active-users-hourly", x: 6, y: 0, w: 6, h: 4 },
      // Row 2
      { i: "deploy-destroy-latency", x: 0, y: 4, w: 6, h: 6 },
      { i: "cli-invocations-by-command", x: 6, y: 4, w: 6, h: 6 },
      // Row 3
      { i: "top-resources", x: 0, y: 10, w: 6, h: 8 },
      { i: "resource-latency", x: 6, y: 10, w: 6, h: 8 },
      // Row 4
      { i: "active-users-by-version", x: 0, y: 18, w: 6, h: 6 },
      { i: "resource-error-rate", x: 6, y: 18, w: 6, h: 6 },
      // Row 5
      { i: "state-store-deploys", x: 0, y: 24, w: 6, h: 6 },
      { i: "state-store-error-rate", x: 6, y: 24, w: 6, h: 6 },
    ];

    return {
      dashboard: {
        name: `${stage} alchemy CLI overview`,
        // Empty owner = X-AXIOM-EVERYONE (org-shared). API tokens
        // can't create per-user "private" dashboards.
        owner: "",
        description:
          "End-user CLI telemetry: active users, resource usage, deploy/destroy and per-resource latency, error rate, and Cloudflare State Store deploy success/error rate.",
        refreshTime: 60 as const,
        schemaVersion: 2 as const,
        // Axiom requires the `qr-now-{duration}` form for relative times.
        timeWindowStart: "qr-now-7d",
        timeWindowEnd: "qr-now",
        charts,
        layout,
      },
    };
  }),
);
