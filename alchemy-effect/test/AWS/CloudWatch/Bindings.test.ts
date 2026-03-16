import { destroy } from "@/Destroy";
import { afterAll, beforeAll, test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";
import { CloudWatchFixture } from "./handler";

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(9)),
);

let baseUrl: string;

const windowRange = () => {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60 * 1000);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
};

describe.sequential("CloudWatch Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("CloudWatch test setup: destroying previous resources");
      yield* destroy();
      yield* Effect.logInfo("CloudWatch test setup: deploying fixture");
      const deployed = yield* test.deploy(CloudWatchFixture);
      baseUrl = deployed.apiFunction.functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ready`;

      yield* Effect.logInfo(
        `CloudWatch test setup: probing readiness at ${readinessUrl} (20s budget)`,
      );

      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : response.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(
                    new Error(
                      `Function not ready: ${response.status}${
                        body ? ` ${body}` : ""
                      }`,
                    ),
                  ),
                ),
              ),
        ),
        Effect.tap(() =>
          Effect.logInfo("CloudWatch test setup: fixture responded successfully"),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `CloudWatch test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 180_000 },
  );

  afterAll(destroy(), { timeout: 120_000 });

  describe("PutMetricData", () => {
    test(
      "publishes a custom metric datapoint",
      Effect.gen(function* () {
        const response = yield* postJson("/metrics/put", { value: 2 });
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("GetMetricStatistics", () => {
    test(
      "returns datapoints for the custom metric",
      { timeout: 180_000 },
      Effect.gen(function* () {
        yield* postJson("/metrics/put", { value: 3 });
        const range = windowRange();

        const response = yield* postJson("/metrics/get-stats", range).pipe(
          Effect.retry({
            while: (result: any) =>
              (result?.value?.Datapoints?.length ?? 0) === 0,
            schedule: Schedule.fixed("15 seconds").pipe(
              Schedule.both(Schedule.recurs(4)),
            ),
          }),
        );

        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.Datapoints ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetMetricData", () => {
    test(
      "queries the custom metric time series",
      { timeout: 180_000 },
      Effect.gen(function* () {
        yield* postJson("/metrics/put", { value: 4 });
        const range = windowRange();

        const response = yield* postJson("/metrics/get-data", range).pipe(
          Effect.retry({
            while: (result: any) =>
              (((result?.value?.MetricDataResults ?? [])[0]?.Values ?? [])
                .length ?? 0) === 0,
            schedule: Schedule.fixed("15 seconds").pipe(
              Schedule.both(Schedule.recurs(4)),
            ),
          }),
        );

        expect((response as any).ok).toBe(true);
        expect(
          (((response as any).value.MetricDataResults ?? [])[0]?.Values ?? [])
            .length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetMetricWidgetImage", () => {
    test(
      "renders a metric widget image",
      Effect.gen(function* () {
        const response = yield* postJson("/metrics/widget-image", {});
        expect((response as any).ok).toBe(true);
        expect((response as any).value.MetricWidgetImage).toBeTruthy();
      }),
    );
  });

  describe("ListMetrics", () => {
    test(
      "lists the custom fixture metric",
      Effect.gen(function* () {
        const response = yield* getJson("/metrics/list");
        expect((response as any).ok).toBe(true);
        expect(((response as any).value.Metrics ?? []).length).toBeGreaterThan(
          0,
        );
      }),
    );
  });

  describe("GetDashboard", () => {
    test(
      "reads the bound dashboard",
      Effect.gen(function* () {
        const response = yield* getJson("/dashboard");
        expect((response as any).ok).toBe(true);
        expect((response as any).value.DashboardBody).toContain(
          "Fixture Metric",
        );
      }),
    );
  });

  describe("ListDashboards", () => {
    test(
      "lists dashboards in the account",
      Effect.gen(function* () {
        const response = yield* getJson("/dashboards");
        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.DashboardEntries ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("DescribeAlarms", () => {
    test(
      "describes the bound metric and composite alarms",
      Effect.gen(function* () {
        const response = yield* getJson("/alarms");
        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.MetricAlarms ?? []).length,
        ).toBeGreaterThan(0);
        expect(
          ((response as any).value.CompositeAlarms ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("DescribeAlarmsForMetric", () => {
    test(
      "finds the metric alarm for the custom metric",
      Effect.gen(function* () {
        const response = yield* getJson("/alarms/for-metric");
        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.MetricAlarms ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("DescribeAlarmHistory", () => {
    test(
      "returns history for the metric alarm",
      Effect.gen(function* () {
        yield* postJson("/alarms/set-state", {});
        const response = yield* getJson("/alarms/history");
        expect((response as any).ok).toBe(true);
        expect((response as any).value.AlarmHistoryItems).toBeDefined();
      }),
    );
  });

  describe("DescribeAlarmContributors", () => {
    test(
      "returns contributors or a structured error",
      Effect.gen(function* () {
        const response = yield* getJson("/alarms/contributors");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("EnableAlarmActions", () => {
    test(
      "enables alarm actions",
      Effect.gen(function* () {
        yield* postJson("/alarms/disable-actions", {});
        const response = yield* postJson("/alarms/enable-actions", {});
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("DisableAlarmActions", () => {
    test(
      "disables alarm actions",
      Effect.gen(function* () {
        const response = yield* postJson("/alarms/disable-actions", {});
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("SetAlarmState", () => {
    test(
      "sets the alarm state for testing",
      Effect.gen(function* () {
        const response = yield* postJson("/alarms/set-state", {});
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("DescribeAnomalyDetectors", () => {
    test(
      "lists the configured anomaly detector",
      Effect.gen(function* () {
        const response = yield* getJson("/anomaly-detectors");
        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.AnomalyDetectors ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("DescribeInsightRules", () => {
    test(
      "lists the configured insight rule",
      Effect.gen(function* () {
        const response = yield* getJson("/insight-rules");
        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.InsightRules ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetInsightRuleReport", () => {
    test(
      "returns a report payload or a structured error",
      Effect.gen(function* () {
        const response = yield* postJson(
          "/insight-rules/report",
          windowRange(),
        );
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("DisableInsightRules", () => {
    test(
      "disables the configured insight rule",
      Effect.gen(function* () {
        const response = yield* postJson("/insight-rules/disable", {});
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("ListManagedInsightRules", () => {
    test(
      "returns the managed insight rules payload",
      Effect.gen(function* () {
        const response = yield* getJson("/insight-rules/managed");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("GetAlarmMuteRule", () => {
    test(
      "reads the configured alarm mute rule",
      Effect.gen(function* () {
        const response = yield* getJson("/mute-rule");
        expect((response as any).ok).toBe(true);
        expect((response as any).value.Name).toBeTruthy();
      }),
    );
  });

  describe("ListAlarmMuteRules", () => {
    test(
      "lists mute rules for the bound alarm",
      Effect.gen(function* () {
        const response = yield* getJson("/mute-rules");
        expect((response as any).ok).toBe(true);
        expect(
          ((response as any).value.AlarmMuteRuleSummaries ?? []).length,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetMetricStream", () => {
    test(
      "returns the metric stream when fixture ARNs are configured",
      Effect.gen(function* () {
        const response = yield* getJson("/metric-stream");
        if ((response as any).skipped) {
          expect((response as any).skipped).toBe(true);
        } else {
          expect((response as any).ok).toBe(true);
          expect((response as any).value.Arn).toBeTruthy();
        }
      }),
    );
  });

  describe("ListMetricStreams", () => {
    test(
      "returns the metric streams payload",
      Effect.gen(function* () {
        const response = yield* getJson("/metric-streams");
        expect((response as any).ok).toBe(true);
        expect((response as any).value.Entries).toBeDefined();
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test(
      "lists ownership tags for the bound alarm",
      Effect.gen(function* () {
        const response = yield* getJson("/tags/alarm");
        expect((response as any).ok).toBe(true);
        const keys = ((response as any).value.Tags ?? []).map(
          (tag: any) => tag.Key,
        );
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
        expect(keys).toContain("fixture");
      }),
    );
  });
});

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) => response.json),
  );

const postJson = (path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((response) => response.json));
