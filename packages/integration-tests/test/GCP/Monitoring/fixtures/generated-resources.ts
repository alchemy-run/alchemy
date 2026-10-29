import * as GCP from "@alchemy.run/gcp";

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
