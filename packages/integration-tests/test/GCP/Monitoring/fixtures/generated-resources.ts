import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** Monitoring resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeGroup = GCP.Monitoring.Group("ProbeGroup", {
  displayName: "production instances",
  filter: 'resource.metadata.region="us-central1"',
});
export const ProbeMetricDescriptor = GCP.Monitoring.MetricDescriptor("ProbeMetricDescriptor", {
  displayName: "Invoice paid amount",
  description: "amount collected per invoice",
  labels: [{ key: "currency", valueType: "STRING" }],
});
export const ProbeNotificationChannel = GCP.Monitoring.NotificationChannel(
  "ProbeNotificationChannel",
  {
    type: "email",
    description: "oncall",
    userLabels: { env: "test" },
  },
);
export const ProbeService = GCP.Monitoring.Service("ProbeService", {
  displayName: "Checkout",
});
export const ProbeUptimeCheckConfig = GCP.Monitoring.UptimeCheckConfig("ProbeUptimeCheckConfig", {
  timeout: "10s",
  period: "600s",
  httpCheck: {
    path: "/",
    port: 443,
    useSsl: true,
    validateSsl: true,
  },
  monitoredResource: {
    type: "uptime_url",
  },
});

export const ProbeAlertPolicy = GCP.Monitoring.AlertPolicy("ProbeAlertPolicy", {
  combiner: "OR",
  enabled: false,
  conditions: [
    {
      displayName: "CPU > 90%",
      conditionThreshold: {
        filter:
          'resource.type = "gce_instance" AND metric.type = "compute.googleapis.com/instance/cpu/utilization"',
        comparison: "COMPARISON_GT",
        thresholdValue: 0.9,
        duration: "60s",
        aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_MEAN" }],
      },
    },
  ],
});
export const ProbeSlo = Effect.gen(function* () {
  const service = yield* ProbeService;
  return yield* GCP.Monitoring.ServicesServiceLevelObjective("ProbeSlo", {
    service: service.name,
    goal: 0.99,
    rollingPeriod: "86400s",
    serviceLevelIndicator: {
      requestBased: {
        distributionCut: {
          distributionFilter:
            'metric.type="serviceruntime.googleapis.com/api/request_latencies" AND resource.type="consumed_api"',
          range: { max: 500 },
        },
      },
    },
  });
});
