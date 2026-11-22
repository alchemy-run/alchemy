import * as Axiom from "@alchemy.run/axiom";
import * as Alchemy from "alchemy";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { Traces } from "./Datasets.ts";

/**
 * `${stage} alchemy CLI overview` — three time series that show how usage
 * is really growing, each split into the ways we filter it:
 *
 *   1. **Developers per day** — distinct `alchemy.user.id` outside CI, as
 *      three lines: every local id (raw), people (est.), and automated
 *      sandboxes.
 *   2. **Projects per day** — distinct `alchemy.git.origin_hash`: all, those
 *      deploying from CI, those run locally.
 *   3. **Deploys per day** — `cli.deploy` spans: all, from CI, local.
 *
 * Why the developer split: an id lives in `~/.alchemy/id`, so anything that
 * starts each run with a fresh home directory (agent sandboxes, container
 * fleets) mints a new id per run. When they don't set `CI`, every run reads
 * as a new developer; from 2026-11-07 two such systems added ~4,000 ids a
 * week. A sandbox fleet runs one repository on identical machines, so a
 * day's ids that share a git origin and a machine shape (runtime, CPUs,
 * memory) are counted as automated once there are 20 or more of them. The
 * rule slightly undercounts people (many developers outside a git repo on
 * the same laptop model look like a fleet), so the line is an estimate.
 *
 * Axiom caps how many groups a `summarize` materializes, and above ~30 days
 * of daily (origin, machine) groups the developer split silently goes
 * wrong, so that chart only ever covers the last 30 days. The projects and
 * deploys charts are plain aggregates and work over any time range.
 *
 * Axiom draws a TimeSeries as lines only when the query ends in
 * `summarize ... by <group>, bin(_time, ...)`; anything after that final
 * summarize turns the chart into a table. So each row is fanned out into the
 * series it belongs to (`pack_array` + `mv-expand`) before that summarize,
 * one line per `series`. (`union` over derived tables returns nothing in
 * Axiom, so it can't build the lines either.)
 *
 * All queries target `${stage}-traces`: Axiom's metrics datasets cannot be
 * queried via APL. Each query is built with `Output.interpolate` against
 * `traces.name` so Alchemy creates the dashboard after the dataset exists;
 * otherwise Axiom rejects it with `BadRequest: ... entity not found`.
 */
export const CliOverviewDashboard = Axiom.Dashboard(
  "CliOverview",
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    const traces = yield* Traces;
    const t = traces.name;
    const isProd = stack.stage === "prod";
    const prodTracesName: Input<string> = isProd
      ? t
      : (yield* Axiom.Dataset.ref("Traces", { stage: "prod" })).name;
    // A `SmartFilter` chart drives every other chart through
    // `declare query_parameters`:
    //
    // - `bin_size`: one point per day or per week.
    // - `alchemy_version`: narrows every chart to one CLI version. The
    //   source query unions in an explicit "All" row with an empty value,
    //   which `isempty(alchemy_version)` short-circuits.
    // - `dataset_filter` (non-prod stages only): preview the dashboard
    //   against `prod-traces`. Charts read `table(dataset_filter)` instead of
    //   a literal `['<name>']` so the parameter takes effect.
    //
    // A fresh stage has no spans, so `service.version` may not exist yet;
    // `column_ifexists` keeps the queries valid against an empty dataset.
    const declarations: Input<string> = isProd
      ? `declare query_parameters (alchemy_version:string = "", bin_size:string = "1d");`
      : Output.interpolate`declare query_parameters (dataset_filter:string = "${t}", alchemy_version:string = "", bin_size:string = "1d");`;
    const datasetExpr: Input<string> = isProd
      ? Output.interpolate`['${t}']`
      : "table(dataset_filter)";
    const versionFilterWhere = `\n              | where isempty(alchemy_version) or tostring(column_ifexists("service.version", "")) == alchemy_version`;

    const charts: Input<Axiom.DashboardProps["dashboard"]["charts"]> = [
      {
        id: "filter-bar",
        type: "SmartFilter",
        name: "Filters",
        filters: [
          ...(isProd
            ? []
            : [
                {
                  id: "dataset_filter",
                  type: "select" as const,
                  name: "dataset",
                  active: true,
                  selectType: "list" as const,
                  options: [
                    {
                      key: `${stack.stage} (this stage)`,
                      value: t,
                      default: true,
                    },
                    {
                      key: "prod (production data)",
                      value: prodTracesName,
                    },
                  ],
                },
              ]),
          {
            id: "bin_size",
            type: "select",
            name: "aggregation period",
            active: true,
            selectType: "list",
            options: [
              { key: "1 day", value: "1d", default: true },
              { key: "7 days", value: "7d" },
            ],
          },
          {
            id: "alchemy_version",
            type: "select",
            name: "alchemy version",
            active: true,
            selectType: "query",
            options: [],
            query: {
              apl: Output.interpolate`
                  ${declarations}
                  let opts = ${datasetExpr}
                    | extend sv = tostring(column_ifexists("service.version", ""))
                    | where sv != ""
                    | distinct sv
                    | sort by sv desc
                    | project key=sv, value=sv;
                  let all = print key="All", value="";
                  union all, opts
                `,
            },
          },
        ],
      },
      {
        id: "developers",
        name: "Developers (last 30 days at most)",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where _time > ago(30d)
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where uid != "" and ci != "true"
              | summarize u=make_set(uid, 100000), n=dcount(uid)
                  by _time=bin(_time, 1d),
                     origin=tostring(['resource.custom']['alchemy.git.origin_hash']),
                     machine=strcat(tostring(['resource.custom']['alchemy.runtime.name']), "/",
                                    tostring(['resource.custom']['host.cpus']), "/",
                                    tostring(['resource.custom']['host.memory_mb']))
              | extend series=pack_array("all local ids (raw)", iff(n >= 20, "automated sandboxes", "people (est.)"))
              | mv-expand series
              | mv-expand u
              | summarize users=dcount(tostring(u))
                  by series=tostring(series), bin(_time, totimespan(bin_size))
            `,
        },
      },
      {
        id: "projects",
        name: "Projects",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | extend p=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where p != ""
              | extend series=pack_array("all projects", iff(ci == "true", "deploying from CI", "run locally"))
              | mv-expand series
              | summarize projects=dcount(p) by series=tostring(series), bin(_time, totimespan(bin_size))
            `,
        },
      },
      {
        id: "deploys",
        name: "Deploys",
        type: "TimeSeries",
        query: {
          apl: Output.interpolate`
              ${declarations}
              ${datasetExpr}${versionFilterWhere}
              | where name == "cli.deploy"
              | extend ci=tostring(['resource.custom']['alchemy.ci'])
              | extend series=pack_array("all deploys", iff(ci == "true", "from CI", "local"))
              | mv-expand series
              | summarize deploys=count() by series=tostring(series), bin(_time, totimespan(bin_size))
            `,
        },
      },
    ];

    const layout: Axiom.DashboardProps["dashboard"]["layout"] = [
      { i: "filter-bar", x: 0, y: 0, w: 12, h: 2 },
      { i: "developers", x: 0, y: 2, w: 12, h: 8 },
      { i: "projects", x: 0, y: 10, w: 6, h: 7 },
      { i: "deploys", x: 6, y: 10, w: 6, h: 7 },
    ];

    return {
      dashboard: {
        name: `${stack.stage} alchemy CLI overview`,
        // Empty owner = X-AXIOM-EVERYONE (org-shared). API tokens
        // can't create per-user "private" dashboards.
        owner: "",
        description: [
          "Developers, projects and deploys per day, each split into lines. ",
          "Developers: local ids (raw), people (est.) and automated sandboxes, ",
          "where a day's 20+ ids sharing a git origin and machine shape count as automated. ",
          "Projects: all, deploying from CI, run locally. Deploys: all, from CI, local.",
        ].join(""),
        refreshTime: 60 as const,
        schemaVersion: 2 as const,
        // Axiom requires the `qr-now-{duration}` form for relative times.
        timeWindowStart: "qr-now-30d",
        timeWindowEnd: "qr-now",
        charts,
        layout,
      },
    };
  }),
);
