<!-- Docs for the generated AWS.ApplicationAutoScaling bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeScalingActivities

Runtime binding for the `DescribeScalingActivities` operation (IAM action
`application-autoscaling:DescribeScalingActivities`).

Returns the scalable target's scaling activities from the previous six
weeks — what scaled, when, why, and whether it succeeded — including
not-scaled reasons when `IncludeNotScaledActivities` is set. Provide the
implementation with
`Effect.provide(AWS.ApplicationAutoScaling.DescribeScalingActivitiesHttp)`.
### Observing Scaling Activity
**Example:** List Recent Scaling Activities
```typescript
// init — bind the operation to the scalable target
const describeScalingActivities =
  yield* AWS.ApplicationAutoScaling.DescribeScalingActivities(target);

// runtime — page through the target's recent activities
const page = yield* describeScalingActivities({ MaxResults: 50 });
for (const activity of page.ScalingActivities ?? []) {
  yield* Effect.log(`${activity.StatusCode}: ${activity.Description}`);
}
```

**Example:** Include Not-Scaled Reasons
```typescript
const page = yield* describeScalingActivities({
  IncludeNotScaledActivities: true,
});
```

@binding

## DescribeScalingActivities.Request

`DescribeScalingActivities` request with the scalable target's identity
triple (`ServiceNamespace`/`ResourceId`/`ScalableDimension`) injected from
the bound {@link ScalableTarget}.

## GetPredictiveScalingForecast

Runtime binding for the `GetPredictiveScalingForecast` operation (IAM
action `application-autoscaling:GetPredictiveScalingForecast`).

Retrieves the load and capacity forecast a predictive scaling policy has
computed for a time window (forecasts are created from at least 24 hours of
historical CloudWatch data). The bound policy must be a `PredictiveScaling`
policy on an ECS service: the API rejects other policy types with the typed
`ValidationException` and namespaces without predictive scaling support
with the typed `PredictiveScalingForecastNotSupported`. Provide the
implementation with
`Effect.provide(AWS.ApplicationAutoScaling.GetPredictiveScalingForecastHttp)`.
### Reading Forecasts
**Example:** Get the Next 48 Hours of Forecast
```typescript
// init — bind the operation to the predictive scaling policy
const getPredictiveScalingForecast =
  yield* AWS.ApplicationAutoScaling.GetPredictiveScalingForecast(policy);

// runtime — read the forecast window
const now = yield* Effect.sync(() => Date.now());
const forecast = yield* getPredictiveScalingForecast({
  StartTime: new Date(now),
  EndTime: new Date(now + 48 * 60 * 60 * 1000),
});
const capacity = forecast.CapacityForecast?.Values ?? [];
```

@binding

## GetPredictiveScalingForecast.Request

`GetPredictiveScalingForecast` request with the policy's identity triple
(`ServiceNamespace`/`ResourceId`/`ScalableDimension`) and `PolicyName`
injected from the bound {@link ScalingPolicy}.
