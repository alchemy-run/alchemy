<!-- Docs for the generated AWS.RUM bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAppMonitorData

Runtime binding for `rum:GetAppMonitorData` — retrieve the raw performance
and error events that CloudWatch RUM collected from the bound
{@link AppMonitor} for your own processing or analysis; the monitor name
is injected automatically.

Provide `RUM.GetAppMonitorDataHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading RUM Telemetry
**Example:** Read the Trailing Hour of Events
```typescript
// init — grants rum:GetAppMonitorData on the monitor
const getAppMonitorData = yield* AWS.RUM.GetAppMonitorData(monitor);

// runtime — each event is a JSON string
const now = Date.now();
const { Events } = yield* getAppMonitorData({
  TimeRange: { After: now - 3_600_000, Before: now },
});
```

@binding
