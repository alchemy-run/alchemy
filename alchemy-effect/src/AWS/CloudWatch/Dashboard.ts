import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import { Resource } from "../../Resource.ts";
import { Account, type AccountID } from "../Account.ts";
import {
  createManagedTags,
  createName,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type DashboardName = string;
export type DashboardArn =
  `arn:aws:cloudwatch::${AccountID}:dashboard/${string}`;

export type DashboardPeriodOverride = "inherit" | "auto";
export type DashboardMetricRow = (string | number | boolean | null)[];

export interface DashboardMetricWidgetProperties {
  title?: string;
  region?: string;
  stat?: string;
  period?: number;
  view?: "timeSeries" | "singleValue" | "gauge" | "bar" | "pie";
  stacked?: boolean;
  metrics: DashboardMetricRow[];
  annotations?: Record<string, unknown>;
  yAxis?: Record<string, unknown>;
  legend?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DashboardTextWidgetProperties {
  markdown: string;
  [key: string]: unknown;
}

export interface DashboardAlarmStatusWidgetProperties {
  alarms: string[];
  title?: string;
  sortBy?: string;
  states?: string[];
  [key: string]: unknown;
}

export interface DashboardLogWidgetProperties {
  query: string;
  region?: string;
  title?: string;
  view?: "table" | "timeSeries" | "bar" | "pie";
  [key: string]: unknown;
}

export interface DashboardMetricWidget {
  type: "metric";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardMetricWidgetProperties;
}

export interface DashboardTextWidget {
  type: "text";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardTextWidgetProperties;
}

export interface DashboardAlarmStatusWidget {
  type: "alarm";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardAlarmStatusWidgetProperties;
}

export interface DashboardLogWidget {
  type: "log";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties: DashboardLogWidgetProperties;
}

export type DashboardWidget =
  | DashboardMetricWidget
  | DashboardTextWidget
  | DashboardAlarmStatusWidget
  | DashboardLogWidget;

export interface DashboardBody {
  start?: string;
  end?: string;
  periodOverride?: DashboardPeriodOverride;
  widgets: DashboardWidget[];
  variables?: Record<string, unknown>[];
}

export interface DashboardProps extends Omit<
  cloudwatch.PutDashboardInput,
  "DashboardName" | "DashboardBody"
> {
  /**
   * Name of the dashboard. If omitted, a unique name is generated.
   */
  name?: DashboardName;
  /**
   * Structured dashboard document. The provider serializes it to the JSON
   * string expected by the CloudWatch API.
   */
  DashboardBody: DashboardBody;
  /**
   * Optional tags to apply to the dashboard.
   */
  tags?: Record<string, string>;
}

export interface Dashboard extends Resource<
  "AWS.CloudWatch.Dashboard",
  DashboardProps,
  {
    dashboardName: DashboardName;
    dashboardArn: DashboardArn;
    dashboardBody: DashboardBody | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An Amazon CloudWatch dashboard.
 *
 * @section Creating Dashboards
 * @example Basic Dashboard
 * ```typescript
 * const dashboard = yield* Dashboard("OpsDashboard", {
 *   DashboardBody: {
 *     widgets: [],
 *   },
 * });
 * ```
 */
export const Dashboard = Resource<Dashboard>("AWS.CloudWatch.Dashboard");

const serializeDashboardBody = (body: DashboardBody) => JSON.stringify(body);

const parseDashboardBody = (body: string | undefined) => {
  if (!body) {
    return undefined;
  }
  return JSON.parse(body) as DashboardBody;
};

export const DashboardProvider = () =>
  Dashboard.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;

      const createDashboardName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const dashboardArn = (dashboardName: string) =>
        `arn:aws:cloudwatch::${accountId}:dashboard/${dashboardName}` as DashboardArn;

      const readDashboard = Effect.fn(function* (dashboardName: string) {
        const output = yield* cloudwatch
          .getDashboard({
            DashboardName: dashboardName,
          })
          .pipe(
            Effect.catchTag("DashboardNotFoundError", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!output?.DashboardName) {
          return undefined;
        }

        const arn = dashboardArn(output.DashboardName);
        const tags = yield* readResourceTags(arn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          dashboardName: output.DashboardName,
          dashboardArn: arn,
          dashboardBody: parseDashboardBody(output.DashboardBody),
          tags,
        };
      });

      return {
        stables: ["dashboardName", "dashboardArn"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {} }) {
          const oldName = yield* createDashboardName(id, olds);
          const newName = yield* createDashboardName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dashboardName ??
            (yield* createDashboardName(id, olds ?? {}));
          return yield* readDashboard(name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createDashboardName(id, news);
          const existing = yield* readDashboard(name);

          if (existing) {
            yield* ensureOwnedByAlchemy(id, name, existing.tags, "dashboard");
          }

          yield* retryConcurrent(
            cloudwatch.putDashboard({
              DashboardName: name,
              DashboardBody: serializeDashboardBody(news.DashboardBody),
            }),
          );

          const tags = yield* createManagedTags(id, news.tags);
          if (Object.keys(tags).length > 0) {
            yield* cloudwatch.tagResource({
              ResourceARN: dashboardArn(name),
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
          }

          yield* session.note(dashboardArn(name));

          const state = yield* readDashboard(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read created dashboard '${name}'`),
            );
          }

          return state;
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* retryConcurrent(
            cloudwatch.putDashboard({
              DashboardName: output.dashboardName,
              DashboardBody: serializeDashboardBody(news.DashboardBody),
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: output.dashboardArn,
            olds: olds.tags,
            news: news.tags,
          });

          yield* session.note(output.dashboardArn);

          return {
            ...output,
            dashboardBody: news.DashboardBody,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrent(
            cloudwatch.deleteDashboards({
              DashboardNames: [output.dashboardName],
            }),
          ).pipe(Effect.catchTag("DashboardNotFoundError", () => Effect.void));
        }),
      };
    }),
  );
