<!-- Docs for the generated AWS.ServiceCatalog bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeProduct

Runtime binding for `servicecatalog:DescribeProduct`.

Gets information about a product the caller has access to, including its provisioning artifacts (versions) and launch paths.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.DescribeProductHttp)`.
### Browsing the Catalog
**Example:** Get a Product's Artifacts and Launch Paths
```typescript
// init — account-level binding, no resource argument
const describeProduct = yield* AWS.ServiceCatalog.DescribeProduct();

// runtime
const { ProductViewSummary, ProvisioningArtifacts } =
  yield* describeProduct({ Id: "prod-abc123" });
```

@binding

## DescribeProvisionedProduct

Runtime binding for `servicecatalog:DescribeProvisionedProduct`.

Gets information about a provisioned product by ID or name — its status (`AVAILABLE`, `UNDER_CHANGE`, `ERROR`, …) and the record of its last operation.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.DescribeProvisionedProductHttp)`.
### Tracking Provisioned Products
**Example:** Get a Provisioned Product's Status
```typescript
// init — account-level binding, no resource argument
const describeProvisionedProduct = yield* AWS.ServiceCatalog.DescribeProvisionedProduct();

// runtime
const { ProvisionedProductDetail } =
  yield* describeProvisionedProduct({ Name: "my-vpc" });
```

@binding

## DescribeProvisioningParameters

Runtime binding for `servicecatalog:DescribeProvisioningParameters`.

Gets the template parameters, constraints, and usage instructions needed to provision a product — call it before `ProvisionProduct` to build the parameter form.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.DescribeProvisioningParametersHttp)`.
### Browsing the Catalog
**Example:** Read a Product's Template Parameters
```typescript
// init — account-level binding, no resource argument
const describeProvisioningParameters = yield* AWS.ServiceCatalog.DescribeProvisioningParameters();

// runtime
const { ProvisioningArtifactParameters } =
  yield* describeProvisioningParameters({
    ProductId: "prod-abc123",
    ProvisioningArtifactId: "pa-abc123",
  });
```

@binding

## DescribeRecord

Runtime binding for `servicecatalog:DescribeRecord`.

Gets a provisioning record — the result of a provision, update, or terminate request. Poll it until the record status is `SUCCEEDED` or `FAILED`.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.DescribeRecordHttp)`.
### Tracking Provisioned Products
**Example:** Poll a Provisioning Record to Completion
```typescript
// init — account-level binding, no resource argument
const describeRecord = yield* AWS.ServiceCatalog.DescribeRecord();

// runtime
const { RecordDetail } = yield* describeRecord({
  Id: "rec-abc123",
});
```

@binding

## DescribeServiceActionExecutionParameters

Runtime binding for `servicecatalog:DescribeServiceActionExecutionParameters`.

Gets the parameters required to execute a self-service action on a provisioned product — call it before `ExecuteProvisionedProductServiceAction` to build the parameter form.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.DescribeServiceActionExecutionParametersHttp)`.
### Service Actions
**Example:** Read a Service Action's Parameters
```typescript
// init — account-level binding, no resource argument
const describeServiceActionExecutionParameters = yield* AWS.ServiceCatalog.DescribeServiceActionExecutionParameters();

// runtime
const { ServiceActionParameters } =
  yield* describeServiceActionExecutionParameters({
    ProvisionedProductId: "pp-abc123",
    ServiceActionId: "act-abc123",
  });
```

@binding

## ExecuteProvisionedProductServiceAction

Runtime binding for `servicecatalog:ExecuteProvisionedProductServiceAction`.

Executes a self-service action (e.g. restart, snapshot — an SSM-document-backed operation the administrator attached to the product) on a provisioned product.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.ExecuteProvisionedProductServiceActionHttp)`.
### Service Actions
**Example:** Execute a Self-Service Action
```typescript
// init — account-level binding, no resource argument
const executeProvisionedProductServiceAction = yield* AWS.ServiceCatalog.ExecuteProvisionedProductServiceAction();

// runtime
const { RecordDetail } =
  yield* executeProvisionedProductServiceAction({
    ProvisionedProductId: "pp-abc123",
    ServiceActionId: "act-abc123",
    ExecuteToken: crypto.randomUUID(),
  });
```

@binding

## GetProvisionedProductOutputs

Runtime binding for `servicecatalog:GetProvisionedProductOutputs`.

Gets the CloudFormation stack outputs of a provisioned product — how downstream code discovers the endpoints and IDs a launched product created.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.GetProvisionedProductOutputsHttp)`.
### Tracking Provisioned Products
**Example:** Read a Provisioned Product's Stack Outputs
```typescript
// init — account-level binding, no resource argument
const getProvisionedProductOutputs = yield* AWS.ServiceCatalog.GetProvisionedProductOutputs();

// runtime
const { Outputs } = yield* getProvisionedProductOutputs({
  ProvisionedProductName: "my-vpc",
});
```

@binding

## ListLaunchPaths

Runtime binding for `servicecatalog:ListLaunchPaths`.

Lists the launch paths (the portfolio routes through which the caller can provision a product). The path ID is required by `ProvisionProduct` when the product is published to more than one portfolio.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.ListLaunchPathsHttp)`.
### Browsing the Catalog
**Example:** Find the Launch Path for a Product
```typescript
// init — account-level binding, no resource argument
const listLaunchPaths = yield* AWS.ServiceCatalog.ListLaunchPaths();

// runtime
const { LaunchPathSummaries } = yield* listLaunchPaths({
  ProductId: "prod-abc123",
});
```

@binding

## ListRecordHistory

Runtime binding for `servicecatalog:ListRecordHistory`.

Lists the caller's past provisioning records (provision, update, and terminate requests), newest first.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.ListRecordHistoryHttp)`.
### Tracking Provisioned Products
**Example:** List Past Provisioning Records
```typescript
// init — account-level binding, no resource argument
const listRecordHistory = yield* AWS.ServiceCatalog.ListRecordHistory();

// runtime
const { RecordDetails } = yield* listRecordHistory();
```

@binding

## ListStackInstancesForProvisionedProduct

Runtime binding for `servicecatalog:ListStackInstancesForProvisionedProduct`.

Lists the CloudFormation stack instances (account/region pairs) of a StackSet-backed provisioned product.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.ListStackInstancesForProvisionedProductHttp)`.
### Tracking Provisioned Products
**Example:** List a StackSet Product's Stack Instances
```typescript
// init — account-level binding, no resource argument
const listStackInstancesForProvisionedProduct = yield* AWS.ServiceCatalog.ListStackInstancesForProvisionedProduct();

// runtime
const { StackInstances } =
  yield* listStackInstancesForProvisionedProduct({
    ProvisionedProductId: "pp-abc123",
  });
```

@binding

## ProvisionProduct

Runtime binding for `servicecatalog:ProvisionProduct`.

Provisions (launches) a product, creating the underlying CloudFormation stack. Returns the in-flight provisioning record — poll it with `DescribeRecord`.

Also grants the CloudFormation stack-creation and template-fetch (`s3:GetObject`) actions Service Catalog performs with the caller's credentials when the product has no launch-role constraint.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.ProvisionProductHttp)`.
### Provisioning Products
**Example:** Launch a Product
```typescript
// init — account-level binding, no resource argument
const provisionProduct = yield* AWS.ServiceCatalog.ProvisionProduct();

// runtime
const { RecordDetail } = yield* provisionProduct({
  ProductId: "prod-abc123",
  ProvisioningArtifactId: "pa-abc123",
  ProvisionedProductName: "my-vpc",
  ProvisionToken: crypto.randomUUID(),
});
```

@binding

## SearchProducts

Runtime binding for `servicecatalog:SearchProducts`.

Searches the products to which the caller has access — the end-user view of the catalog (products published to a portfolio the caller's principal is associated with).

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.SearchProductsHttp)`.
### Browsing the Catalog
**Example:** List the Products the Caller Can Launch
```typescript
// init — account-level binding, no resource argument
const searchProducts = yield* AWS.ServiceCatalog.SearchProducts();

// runtime
const { ProductViewSummaries } = yield* searchProducts();
```

@binding

## SearchProvisionedProducts

Runtime binding for `servicecatalog:SearchProvisionedProducts`.

Searches the provisioned products the caller has access to, with optional free-text filters and account-level access filters.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.SearchProvisionedProductsHttp)`.
### Tracking Provisioned Products
**Example:** List the Caller's Provisioned Products
```typescript
// init — account-level binding, no resource argument
const searchProvisionedProducts = yield* AWS.ServiceCatalog.SearchProvisionedProducts();

// runtime
const { ProvisionedProducts } = yield* searchProvisionedProducts();
```

@binding

## TerminateProvisionedProduct

Runtime binding for `servicecatalog:TerminateProvisionedProduct`.

Terminates a provisioned product, deleting the underlying CloudFormation stack. Returns the in-flight record — poll it with `DescribeRecord`.

Also grants the CloudFormation stack-deletion actions Service Catalog performs with the caller's credentials when the product has no launch-role constraint.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.TerminateProvisionedProductHttp)`.
### Provisioning Products
**Example:** Terminate a Provisioned Product
```typescript
// init — account-level binding, no resource argument
const terminateProvisionedProduct = yield* AWS.ServiceCatalog.TerminateProvisionedProduct();

// runtime
const { RecordDetail } = yield* terminateProvisionedProduct({
  ProvisionedProductName: "my-vpc",
  TerminateToken: crypto.randomUUID(),
});
```

@binding

## UpdateProvisionedProduct

Runtime binding for `servicecatalog:UpdateProvisionedProduct`.

Updates a provisioned product to a new provisioning artifact (version), parameters, or launch path — the self-service equivalent of a stack update. Returns the in-flight record.

Also grants the CloudFormation stack-update actions Service Catalog performs with the caller's credentials when the product has no launch-role constraint.

Account-level operation — which products the caller can see and act on
is governed by portfolio principal associations, so the binding takes no
resource argument. Provide the implementation with
`Effect.provide(AWS.ServiceCatalog.UpdateProvisionedProductHttp)`.
### Provisioning Products
**Example:** Update a Provisioned Product to a New Version
```typescript
// init — account-level binding, no resource argument
const updateProvisionedProduct = yield* AWS.ServiceCatalog.UpdateProvisionedProduct();

// runtime
const { RecordDetail } = yield* updateProvisionedProduct({
  ProvisionedProductName: "my-vpc",
  ProvisioningArtifactName: "v2",
  UpdateToken: crypto.randomUUID(),
});
```

@binding
