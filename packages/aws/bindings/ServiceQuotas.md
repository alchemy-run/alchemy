<!-- Docs for the generated AWS.ServiceQuotas bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAWSDefaultServiceQuota

Runtime binding for `servicequotas:GetAWSDefaultServiceQuota` — read the
AWS default value of a quota (the value that applies when no account
override exists) from inside a Function.

### Reading Quotas
**Example:** Read the default VPCs-per-region quota
```typescript
// init
const getAWSDefaultServiceQuota =
  yield* AWS.ServiceQuotas.GetAWSDefaultServiceQuota();

// runtime
const { Quota } = yield* getAWSDefaultServiceQuota({
  ServiceCode: "vpc",
  QuotaCode: "L-F678F1CE",
});
const defaultValue = Quota?.Value;
```

@binding

## GetAutoManagementConfiguration

Runtime binding for `servicequotas:GetAutoManagementConfiguration` — read
the account's Service Quotas Auto Management opt-in status (opt-in type,
notification target, excluded quotas) from inside a Function.

### Auto Management
**Example:** Check the Auto Management opt-in status
```typescript
// init
const getAutoManagementConfiguration =
  yield* AWS.ServiceQuotas.GetAutoManagementConfiguration();

// runtime — fails with the typed NoSuchResourceException when the
// account has not opted in to Auto Management
const config = yield* getAutoManagementConfiguration();
const optIn = config.OptInType; // NotifyOnly | NotifyAndAdjust
```

@binding

## GetQuotaUtilizationReport

Runtime binding for `servicequotas:GetQuotaUtilizationReport` — read the
result of a utilization report started with
{@link StartQuotaUtilizationReport | StartQuotaUtilizationReport} from
inside a Function.

### Utilization Reports
**Example:** Read a utilization report
```typescript
// init
const getQuotaUtilizationReport =
  yield* AWS.ServiceQuotas.GetQuotaUtilizationReport();

// runtime
const { Status, QuotaUtilizationList } = yield* getQuotaUtilizationReport({
  ReportId: reportId,
});
```

@binding

## GetRequestedServiceQuotaChange

Runtime binding for `servicequotas:GetRequestedServiceQuotaChange` — read
the status of a quota increase request from inside a Function (e.g. to
poll a request submitted with
{@link RequestServiceQuotaIncrease | RequestServiceQuotaIncrease}).

### Quota Increase Requests
**Example:** Poll a quota increase request
```typescript
// init
const getRequestedServiceQuotaChange =
  yield* AWS.ServiceQuotas.GetRequestedServiceQuotaChange();

// runtime
const { RequestedQuota } = yield* getRequestedServiceQuotaChange({
  RequestId: requestId,
});
const status = RequestedQuota?.Status; // PENDING | APPROVED | ...
```

@binding

## GetServiceQuota

Runtime binding for `servicequotas:GetServiceQuota` — read the applied
value of any Service Quotas quota (account-level or resource-level) from
inside a Function.

Service Quotas is a read-mostly control-plane service with no resource to
manage for reads: the binding takes no arguments and grants the function
`servicequotas:GetServiceQuota` (the action has no resource-level IAM).
Pass the raw distilled request — no marshalling.

### Reading Quotas
**Example:** Read the Lambda concurrent-executions quota
```typescript
// init
const getServiceQuota = yield* AWS.ServiceQuotas.GetServiceQuota();

// runtime
const { Quota } = yield* getServiceQuota({
  ServiceCode: "lambda",
  QuotaCode: "L-B99A9384",
});
const applied = Quota?.Value;
```

@binding

## ListAWSDefaultServiceQuotas

Runtime binding for `servicequotas:ListAWSDefaultServiceQuotas` — list the
AWS default values for every quota of a service from inside a Function.

### Listing Quotas
**Example:** List Lambda's default quotas
```typescript
// init
const listAWSDefaultServiceQuotas =
  yield* AWS.ServiceQuotas.ListAWSDefaultServiceQuotas();

// runtime
const { Quotas } = yield* listAWSDefaultServiceQuotas({
  ServiceCode: "lambda",
});
```

@binding

## ListRequestedServiceQuotaChangeHistory

Runtime binding for
`servicequotas:ListRequestedServiceQuotaChangeHistory` — list quota
increase requests in the account's 90-day request history from inside a
Function, optionally filtered by service or status.

### Quota Increase Requests
**Example:** List pending requests
```typescript
// init
const listRequestedServiceQuotaChangeHistory =
  yield* AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistory();

// runtime
const { RequestedQuotas } = yield* listRequestedServiceQuotaChangeHistory({
  Status: "PENDING",
});
```

@binding

## ListRequestedServiceQuotaChangeHistoryByQuota

Runtime binding for
`servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota` — list quota
increase requests for one specific quota from inside a Function.

### Quota Increase Requests
**Example:** List requests for the Lambda concurrency quota
```typescript
// init
const listRequestedServiceQuotaChangeHistoryByQuota =
  yield* AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistoryByQuota();

// runtime
const { RequestedQuotas } =
  yield* listRequestedServiceQuotaChangeHistoryByQuota({
    ServiceCode: "lambda",
    QuotaCode: "L-B99A9384",
  });
```

@binding

## ListServiceQuotas

Runtime binding for `servicequotas:ListServiceQuotas` — list the applied
quota values for a service from inside a Function.

### Listing Quotas
**Example:** List VPC quotas
```typescript
// init
const listServiceQuotas = yield* AWS.ServiceQuotas.ListServiceQuotas();

// runtime
const { Quotas } = yield* listServiceQuotas({
  ServiceCode: "vpc",
  MaxResults: 50,
});
```

@binding

## ListServices

Runtime binding for `servicequotas:ListServices` — list the services that
integrate with Service Quotas (and their service codes) from inside a
Function.

### Listing Quotas
**Example:** Discover service codes
```typescript
// init
const listServices = yield* AWS.ServiceQuotas.ListServices();

// runtime
const { Services } = yield* listServices({ MaxResults: 100 });
const lambda = Services?.find((s) => s.ServiceCode === "lambda");
```

@binding

## RequestServiceQuotaIncrease

Runtime binding for `servicequotas:RequestServiceQuotaIncrease` — submit a
quota increase request from inside a Function (e.g. automatically request
more capacity when utilization approaches the limit).

:::caution
Submitting a request may open an AWS Support case and cannot be cancelled
through the Service Quotas API. For declaratively managed increases prefer
the {@link ServiceQuotaIncreaseRequest} resource.
:::

### Quota Increase Requests
**Example:** Request more concurrent executions
```typescript
// init
const requestServiceQuotaIncrease =
  yield* AWS.ServiceQuotas.RequestServiceQuotaIncrease();

// runtime
const { RequestedQuota } = yield* requestServiceQuotaIncrease({
  ServiceCode: "lambda",
  QuotaCode: "L-B99A9384",
  DesiredValue: 2000,
});
const requestId = RequestedQuota?.Id;
```

@binding

## StartQuotaUtilizationReport

Runtime binding for `servicequotas:StartQuotaUtilizationReport` — kick off
an asynchronous account-wide quota utilization report from inside a
Function. Poll the result with
{@link GetQuotaUtilizationReport | GetQuotaUtilizationReport}.

### Utilization Reports
**Example:** Start a utilization report
```typescript
// init
const startQuotaUtilizationReport =
  yield* AWS.ServiceQuotas.StartQuotaUtilizationReport();

// runtime
const { ReportId } = yield* startQuotaUtilizationReport();
```

@binding
