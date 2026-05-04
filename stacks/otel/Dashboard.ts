import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Effect } from "effect";
import { Traces } from "./Datasets.ts";

/**
 * `${stage} alchemy CLI overview` — a single dashboard answering the
 * four questions we actually care about, laid out on a 12-column grid:
 *
 *   1. **How many active users are working on a project?**
 *      Distinct `alchemy.user.id` per `alchemy.git.origin_hash`.
 *   2. **How many distinct projects are there?**
 *      Distinct `alchemy.git.origin_hash`.
 *   3. **How many projects use CI/CD?**
 *      Distinct `alchemy.git.origin_hash` where `alchemy.ci=true`.
 *   4. **What state stores are people using?**
 *      Sourced from `state_store.init` spans tagged with
 *      `alchemy.state_store.id` (the open-ended `StateService.id`
 *      slug; built-ins are `local` / `inmemory` / `http` /
 *      `cloudflare-http`, third-party stores get tracked automatically
 *      by setting their own slug). Emitted once per process via
 *      `recordStateStoreInit` at every `Layer.effect(State, …)` site.
 *
 * Project identity uses `alchemy.git.origin_hash` rather than
 * `alchemy.user.id`: ephemeral CI runners regenerate `~/.alchemy/id`
 * every job, which dramatically inflates the user count. The git
 * origin hash is stable across runs of the same repo and is the
 * closest proxy we have for "a project".
 *
 * All queries target `${stage}-traces` — Axiom's metrics datasets
 * cannot be queried via APL, but every metric we emit has an
 * equivalent span (`cli.<command>`, `provider.<op>`,
 * `state_store.deploy`, `state_store.init`).
 *
 * Each chart's APL query is built with `Output.interpolate` against
 * `traces.name` so Alchemy sequences the dashboard after the dataset
 * exists. Otherwise Axiom would reject creation with
 * `BadRequest: failed to validate ... entity not found`.
 */
export const CliOverviewDashboard = Axiom.Dashboard(
  "CliOverview",
  Effect.all([Alchemy.Stack.asEffect(), Traces]).pipe(
    Effect.map(([stack, traces]) => {
      const t = traces.name;
      const charts: Input<Axiom.Chart>[] = [
        // Row 1 — top-line counts answering Qs 1, 2, 3.
        {
          id: "distinct-projects",
          name: "Distinct projects (7d)",
          type: "Statistic",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash'])
              | where project != ""
              | summarize projects=dcount(project)
            `,
          },
        },
        {
          id: "projects-using-ci",
          name: "Projects using CI/CD (7d)",
          type: "Statistic",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != "" and ci == "true"
              | summarize projects=dcount(project)
            `,
          },
        },
        {
          id: "active-users-7d",
          name: "Active users — non-CI (7d)",
          type: "Statistic",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where ci != "true"
              | summarize users=dcount(uid)
            `,
          },
        },

        // Row 2 — Q1 broken out per-project, plus solo-vs-team split.
        {
          id: "users-per-project",
          name: "Active users per project (7d)",
          type: "Table",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != ""
              | summarize users_total=dcount(uid),
                          users_local=dcountif(uid, ci != "true"),
                          users_ci=dcountif(uid, ci == "true"),
                          events=count()
                  by project
              | order by users_total desc
              | take 100
            `,
          },
        },
        {
          id: "project-team-size-distribution",
          name: "Project team-size distribution (local users / project)",
          type: "Table",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != "" and ci != "true"
              | summarize users=dcount(uid) by project
              | extend bucket = case(
                  users == 1, "1 (solo)",
                  users <= 3, "2-3",
                  users <= 10, "4-10",
                  "11+")
              | summarize projects=count() by bucket
              | order by bucket asc
            `,
          },
        },

        // Row 3 — Q4: state-store breakdown.
        {
          id: "state-store-projects-by-id",
          name: "Projects by state store (7d)",
          type: "Table",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | where name == "state_store.init"
              | extend store=tostring(['attributes.custom']['alchemy.state_store.id']),
                       project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       uid=tostring(['resource.custom']['alchemy.user.id'])
              | summarize projects=dcountif(project, project != ""),
                          users=dcount(uid),
                          inits=count()
                  by store
              | order by projects desc
            `,
          },
        },
        {
          id: "state-store-by-id-over-time",
          name: "State store init by store / hour",
          type: "TimeSeries",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | where name == "state_store.init"
              | extend store=tostring(['attributes.custom']['alchemy.state_store.id'])
              | summarize count=count() by store, bin_auto(_time)
              | order by _time asc
            `,
          },
        },

        // Row 4 — adoption shape: project growth + CI-vs-local split.
        {
          id: "projects-over-time",
          name: "Distinct projects per day",
          type: "TimeSeries",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash'])
              | where project != ""
              | summarize projects=dcount(project) by bin(_time, 1d)
              | order by _time asc
            `,
          },
        },
        {
          id: "active-users-over-time-hourly",
          name: "Active users per hour (non-CI)",
          type: "TimeSeries",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where ci != "true" and uid != ""
              | summarize users=dcount(uid) by bin(_time, 1h)
              | order by _time asc
            `,
          },
        },
        {
          id: "active-users-over-time-daily",
          name: "Active users per day (CI vs local)",
          type: "TimeSeries",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where uid != ""
              | extend bucket=iff(ci == "true", "ci", "local")
              | summarize users=dcount(uid) by bucket, bin(_time, 1d)
              | order by _time asc
            `,
          },
        },
        {
          id: "ci-vs-local-projects",
          name: "Projects: CI vs local per day",
          type: "TimeSeries",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend project=tostring(['resource.custom']['alchemy.git.origin_hash']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | where project != ""
              | extend bucket=iff(ci == "true", "ci", "local")
              | summarize projects=dcount(project) by bucket, bin(_time, 1d)
              | order by _time asc
            `,
          },
        },

        // Row 5 — keep the state-store deploy health signals for the
        // Cloudflare-hosted store (not just init, but actual deploys).
        {
          id: "state-store-deploys",
          name: "Cloudflare state store deploys (success vs error)",
          type: "TimeSeries",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | where name == "state_store.deploy"
              | extend status=iff(tobool(['error']), "error", "success")
              | summarize count=count() by status, bin_auto(_time)
              | order by _time asc
            `,
          },
        },
        {
          id: "active-users-by-version",
          name: "Active users by alchemy version (7d)",
          type: "Table",
          query: {
            apl: Output.interpolate`
              ['${t}']
              | extend uid=tostring(['resource.custom']['alchemy.user.id']),
                       version=tostring(['resource.custom']['alchemy.version']),
                       ci=tostring(['resource.custom']['alchemy.ci'])
              | summarize users_total=dcount(uid),
                          users_local=dcountif(uid, ci != "true"),
                          users_ci=dcountif(uid, ci == "true")
                  by version
              | order by users_total desc
            `,
          },
        },
      ];

      const layout: Axiom.LayoutCell[] = [
        // Row 1
        { i: "distinct-projects", x: 0, y: 0, w: 4, h: 4 },
        { i: "projects-using-ci", x: 4, y: 0, w: 4, h: 4 },
        { i: "active-users-7d", x: 8, y: 0, w: 4, h: 4 },
        // Row 2 — active users over time
        { i: "active-users-over-time-hourly", x: 0, y: 4, w: 6, h: 6 },
        { i: "active-users-over-time-daily", x: 6, y: 4, w: 6, h: 6 },
        // Row 3
        { i: "users-per-project", x: 0, y: 10, w: 8, h: 8 },
        { i: "project-team-size-distribution", x: 8, y: 10, w: 4, h: 8 },
        // Row 4
        { i: "state-store-projects-by-id", x: 0, y: 18, w: 6, h: 6 },
        { i: "state-store-by-id-over-time", x: 6, y: 18, w: 6, h: 6 },
        // Row 5
        { i: "projects-over-time", x: 0, y: 24, w: 6, h: 6 },
        { i: "ci-vs-local-projects", x: 6, y: 24, w: 6, h: 6 },
        // Row 6
        { i: "state-store-deploys", x: 0, y: 30, w: 6, h: 6 },
        { i: "active-users-by-version", x: 6, y: 30, w: 6, h: 6 },
      ];

      return {
        dashboard: {
          name: `${stack.stage} alchemy CLI overview`,
          // Empty owner = X-AXIOM-EVERYONE (org-shared). API tokens
          // can't create per-user "private" dashboards.
          owner: "",
          description:
            "Adoption telemetry: distinct projects, active users per project, " +
            "CI vs local usage, and state-store backend breakdown. " +
            "Project identity = alchemy.git.origin_hash (stable across CI runs); " +
            "user identity = alchemy.user.id (ephemeral in CI).",
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
  ),
);
