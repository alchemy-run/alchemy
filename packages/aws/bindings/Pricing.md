<!-- Docs for the generated AWS.Pricing bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeServices

Runtime binding for `pricing:DescribeServices` — list the service codes
known to the AWS Price List API, or the filterable attribute names of one
service.

Call it without a `ServiceCode` to enumerate every service code, or with
one (e.g. `AmazonEC2`) to get the attribute names you can filter
`GetProducts` by (`instanceType`, `location`, `operatingSystem`, ...).
The binding takes no arguments and grants the function
`pricing:DescribeServices` (the action has no resource-level IAM). Calls
are pinned to `us-east-1`, the region that serves the Price List API.
Provide the implementation with
`Effect.provide(AWS.Pricing.DescribeServicesHttp)`.

### Discovering Services
**Example:** List Filterable Attributes for EC2
```typescript
// init
const describeServices = yield* AWS.Pricing.DescribeServices();

// runtime
const result = yield* describeServices({ ServiceCode: "AmazonEC2" });
const attributeNames = result.Services?.[0]?.AttributeNames ?? [];
```

@binding

## GetAttributeValues

Runtime binding for `pricing:GetAttributeValues` — list the values of a
filterable attribute (e.g. every `volumeType` AWS prices for
`AmazonEC2`).

Use `DescribeServices` to discover attribute names, then this binding to
enumerate their values, and feed both into `GetProducts` filters. The
binding takes no arguments and grants the function
`pricing:GetAttributeValues` (the action has no resource-level IAM).
Calls are pinned to `us-east-1`, the region that serves the Price List
API. Provide the implementation with
`Effect.provide(AWS.Pricing.GetAttributeValuesHttp)`.

### Listing Attribute Values
**Example:** List EC2 Volume Types
```typescript
// init
const getAttributeValues = yield* AWS.Pricing.GetAttributeValues();

// runtime
const result = yield* getAttributeValues({
  ServiceCode: "AmazonEC2",
  AttributeName: "volumeType",
});
const volumeTypes = (result.AttributeValues ?? []).map((v) => v.Value);
```

@binding

## GetPriceListFileUrl

Runtime binding for `pricing:GetPriceListFileUrl` — resolve a presigned
download URL for one bulk Price List file.

Takes a `PriceListArn` and `FileFormat` (`csv` or `json`) obtained from
`ListPriceLists` and returns the URL the full offer file can be fetched
from. The binding takes no arguments and grants the function
`pricing:GetPriceListFileUrl` (the action has no resource-level IAM).
Calls are pinned to `us-east-1`, the region that serves the Price List
API. Provide the implementation with
`Effect.provide(AWS.Pricing.GetPriceListFileUrlHttp)`.

### Downloading Price List Files
**Example:** Resolve a Price List Download URL
```typescript
// init
const listPriceLists = yield* AWS.Pricing.ListPriceLists();
const getPriceListFileUrl = yield* AWS.Pricing.GetPriceListFileUrl();

// runtime
const lists = yield* listPriceLists({
  ServiceCode: "AmazonEC2",
  CurrencyCode: "USD",
  EffectiveDate: new Date(),
  RegionCode: "us-east-1",
});
const arn = lists.PriceLists?.[0]?.PriceListArn;
if (arn !== undefined) {
  const { Url } = yield* getPriceListFileUrl({
    PriceListArn: arn,
    FileFormat: "json",
  });
}
```

@binding

## GetProducts

Runtime binding for `pricing:GetProducts` — query the AWS Price List API
for all products that match the filter criteria.

The Price List Query API is a global, data-only service with no resource
to manage: the binding takes no arguments and grants the function
`pricing:GetProducts` (the action has no resource-level IAM). Calls are
pinned to `us-east-1`, the region that serves the Price List API,
regardless of where the function runs. Each `PriceList` entry is a JSON
string describing one product and its terms. Provide the implementation
with `Effect.provide(AWS.Pricing.GetProductsHttp)`.

### Querying Products
**Example:** Look Up EC2 On-Demand Pricing
```typescript
// init
const getProducts = yield* AWS.Pricing.GetProducts();

// runtime
const result = yield* getProducts({
  ServiceCode: "AmazonEC2",
  Filters: [
    { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
    { Type: "TERM_MATCH", Field: "location", Value: "US East (N. Virginia)" },
    { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
  ],
  MaxResults: 10,
});
const products = (result.PriceList ?? []).map((item) => JSON.parse(item));
```

@binding

## ListPriceLists

Runtime binding for `pricing:ListPriceLists` — list the bulk Price List
file references available for a service, currency, and effective date.

Each returned reference carries a `PriceListArn` and the `FileFormats`
it can be downloaded in (`csv`, `json`); pass the ARN and a format to
`GetPriceListFileUrl` to obtain a presigned download URL. Use without a
`RegionCode` to list Price Lists from every AWS Region, or with one to
narrow to a single Region. The binding takes no arguments and grants the
function `pricing:ListPriceLists` (the action has no resource-level
IAM). Calls are pinned to `us-east-1`, the region that serves the Price
List API. Provide the implementation with
`Effect.provide(AWS.Pricing.ListPriceListsHttp)`.

### Listing Price List Files
**Example:** List EC2 Price Lists for us-east-1
```typescript
// init
const listPriceLists = yield* AWS.Pricing.ListPriceLists();

// runtime
const result = yield* listPriceLists({
  ServiceCode: "AmazonEC2",
  CurrencyCode: "USD",
  EffectiveDate: new Date(),
  RegionCode: "us-east-1",
});
const arns = (result.PriceLists ?? []).map((p) => p.PriceListArn);
```

@binding
