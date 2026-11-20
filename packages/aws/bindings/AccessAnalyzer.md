<!-- Docs for the generated AWS.AccessAnalyzer bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ApplyArchiveRule

Runtime binding for `access-analyzer:ApplyArchiveRule`.

Retroactively applies an archive rule to the analyzer's existing findings.
Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.ApplyArchiveRuleHttp)`.
### Managing Findings
**Example:** Apply an Archive Rule to Existing Findings
```typescript
const applyRule = yield* AWS.AccessAnalyzer.ApplyArchiveRule(analyzer);
yield* applyRule({ ruleName: rule.ruleName });
```

@binding

## ApplyArchiveRule.Request

`ApplyArchiveRule` request with `analyzerArn` injected from the bound {@link Analyzer}.

## CancelPolicyGeneration

Runtime binding for `access-analyzer:CancelPolicyGeneration`.

Cancels an in-progress policy-generation job. Provide the implementation
with `Effect.provide(AWS.AccessAnalyzer.CancelPolicyGenerationHttp)`.
### Policy Generation
**Example:** Cancel a Generation Job
```typescript
const cancelGeneration =
  yield* AWS.AccessAnalyzer.CancelPolicyGeneration();
yield* cancelGeneration({ jobId });
```

@binding

## CheckAccessNotGranted

Runtime binding for `access-analyzer:CheckAccessNotGranted`.

Custom policy check: verifies a policy does not grant the specified actions
or resource access. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.CheckAccessNotGrantedHttp)`.
### Custom Policy Checks
**Example:** Assert a Policy Cannot Delete Buckets
```typescript
const checkAccessNotGranted =
  yield* AWS.AccessAnalyzer.CheckAccessNotGranted();
const result = yield* checkAccessNotGranted({
  policyDocument: JSON.stringify(policy),
  policyType: "IDENTITY_POLICY",
  access: [{ actions: ["s3:DeleteBucket"] }],
});
// result.result === "PASS" | "FAIL"
```

@binding

## CheckNoNewAccess

Runtime binding for `access-analyzer:CheckNoNewAccess`.

Custom policy check: verifies an updated policy grants no access beyond what
the existing policy allows. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.CheckNoNewAccessHttp)`.
### Custom Policy Checks
**Example:** Compare an Updated Policy Against the Existing One
```typescript
const checkNoNewAccess = yield* AWS.AccessAnalyzer.CheckNoNewAccess();
const result = yield* checkNoNewAccess({
  existingPolicyDocument: JSON.stringify(existing),
  newPolicyDocument: JSON.stringify(proposed),
  policyType: "IDENTITY_POLICY",
});
```

@binding

## CheckNoPublicAccess

Runtime binding for `access-analyzer:CheckNoPublicAccess`.

Custom policy check: verifies a resource policy cannot grant public access
for the given resource type. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.CheckNoPublicAccessHttp)`.
### Custom Policy Checks
**Example:** Assert a Bucket Policy Is Not Public
```typescript
const checkNoPublicAccess =
  yield* AWS.AccessAnalyzer.CheckNoPublicAccess();
const result = yield* checkNoPublicAccess({
  policyDocument: JSON.stringify(bucketPolicy),
  resourceType: "AWS::S3::Bucket",
});
```

@binding

## CreateAccessPreview

Runtime binding for `access-analyzer:CreateAccessPreview`.

Previews the findings a proposed resource policy would generate, before
deploying the policy. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.CreateAccessPreviewHttp)`.
### Access Previews
**Example:** Preview a Proposed Bucket Policy
```typescript
const createPreview =
  yield* AWS.AccessAnalyzer.CreateAccessPreview(analyzer);
const preview = yield* createPreview({
  configurations: {
    [bucketArn]: { s3Bucket: { bucketPolicy: proposedPolicy } },
  },
});
```

@binding

## CreateAccessPreview.Request

`CreateAccessPreview` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GenerateFindingRecommendation

Runtime binding for `access-analyzer:GenerateFindingRecommendation`.

Starts generating a remediation recommendation for an unused-permissions
finding. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GenerateFindingRecommendationHttp)`.
### Finding Recommendations
**Example:** Generate a Recommendation
```typescript
const generate =
  yield* AWS.AccessAnalyzer.GenerateFindingRecommendation(analyzer);
yield* generate({ id: findingId });
```

@binding

## GenerateFindingRecommendation.Request

`GenerateFindingRecommendation` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetAccessPreview

Runtime binding for `access-analyzer:GetAccessPreview`.

Retrieves an access preview's status and configuration. Provide the
implementation with
`Effect.provide(AWS.AccessAnalyzer.GetAccessPreviewHttp)`.
### Access Previews
**Example:** Poll a Preview Until Completed
```typescript
const getPreview = yield* AWS.AccessAnalyzer.GetAccessPreview(analyzer);
const preview = yield* getPreview({ accessPreviewId });
```

@binding

## GetAccessPreview.Request

`GetAccessPreview` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetAnalyzedResource

Runtime binding for `access-analyzer:GetAnalyzedResource`.

Retrieves the analysis status and sharing summary for a resource the
analyzer has scanned. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GetAnalyzedResourceHttp)`.
### Scanning Resources
**Example:** Inspect an Analyzed Resource
```typescript
const getResource =
  yield* AWS.AccessAnalyzer.GetAnalyzedResource(analyzer);
const analyzed = yield* getResource({ resourceArn: bucket.bucketArn });
```

@binding

## GetAnalyzedResource.Request

`GetAnalyzedResource` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetFinding

Runtime binding for `access-analyzer:GetFinding`.

Retrieves a single external-access finding (V1 API — prefer {@link
GetFindingV2}). Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GetFindingHttp)`.
### Reading Findings
**Example:** Get a Finding by Id (V1)
```typescript
const getFinding = yield* AWS.AccessAnalyzer.GetFinding(analyzer);
const result = yield* getFinding({ id: findingId });
```

@binding

## GetFinding.Request

`GetFinding` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetFindingRecommendation

Runtime binding for `access-analyzer:GetFindingRecommendation`.

Retrieves the generated remediation recommendation for an unused-permissions
finding. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GetFindingRecommendationHttp)`.
### Finding Recommendations
**Example:** Read a Recommendation
```typescript
const getRecommendation =
  yield* AWS.AccessAnalyzer.GetFindingRecommendation(analyzer);
const recommendation = yield* getRecommendation({ id: findingId });
```

@binding

## GetFindingRecommendation.Request

`GetFindingRecommendation` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetFindingV2

Runtime binding for the `GetFindingV2` operation (IAM action
`access-analyzer:GetFinding` — shared with the V1 API).

Retrieves a single finding with its typed `findingDetails` (external-access
or unused-access). Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GetFindingV2Http)`.
### Reading Findings
**Example:** Get a Finding by Id
```typescript
const getFinding = yield* AWS.AccessAnalyzer.GetFindingV2(analyzer);
const finding = yield* getFinding({ id: findingId });
```

@binding

## GetFindingV2.Request

`GetFindingV2` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetFindingsStatistics

Runtime binding for `access-analyzer:GetFindingsStatistics`.

Retrieves aggregate finding statistics for the analyzer (counts by resource
type or unused-access age). Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GetFindingsStatisticsHttp)`.
### Reading Findings
**Example:** Get Finding Statistics
```typescript
const getStatistics =
  yield* AWS.AccessAnalyzer.GetFindingsStatistics(analyzer);
const stats = yield* getStatistics();
```

@binding

## GetFindingsStatistics.Request

`GetFindingsStatistics` request with `analyzerArn` injected from the bound {@link Analyzer}.

## GetGeneratedPolicy

Runtime binding for `access-analyzer:GetGeneratedPolicy`.

Retrieves the status and result of a policy-generation job started with
{@link StartPolicyGeneration}. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.GetGeneratedPolicyHttp)`.
### Policy Generation
**Example:** Read the Generated Policy
```typescript
const getGenerated = yield* AWS.AccessAnalyzer.GetGeneratedPolicy();
const generated = yield* getGenerated({ jobId });
```

@binding

## ListAccessPreviewFindings

Runtime binding for `access-analyzer:ListAccessPreviewFindings`.

Lists the findings a completed access preview produced. Provide the
implementation with
`Effect.provide(AWS.AccessAnalyzer.ListAccessPreviewFindingsHttp)`.
### Access Previews
**Example:** Read Preview Findings
```typescript
const listPreviewFindings =
  yield* AWS.AccessAnalyzer.ListAccessPreviewFindings(analyzer);
const page = yield* listPreviewFindings({ accessPreviewId });
```

@binding

## ListAccessPreviewFindings.Request

`ListAccessPreviewFindings` request with `analyzerArn` injected from the bound {@link Analyzer}.

## ListAccessPreviews

Runtime binding for `access-analyzer:ListAccessPreviews`.

Lists the analyzer's access previews. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.ListAccessPreviewsHttp)`.
### Access Previews
**Example:** List Access Previews
```typescript
const listPreviews =
  yield* AWS.AccessAnalyzer.ListAccessPreviews(analyzer);
const page = yield* listPreviews();
```

@binding

## ListAccessPreviews.Request

`ListAccessPreviews` request with `analyzerArn` injected from the bound {@link Analyzer}.

## ListAnalyzedResources

Runtime binding for `access-analyzer:ListAnalyzedResources`.

Lists the resources the analyzer has scanned, optionally filtered by
resource type. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.ListAnalyzedResourcesHttp)`.
### Scanning Resources
**Example:** List Analyzed S3 Buckets
```typescript
const listResources =
  yield* AWS.AccessAnalyzer.ListAnalyzedResources(analyzer);
const page = yield* listResources({
  resourceType: "AWS::S3::Bucket",
});
```

@binding

## ListAnalyzedResources.Request

`ListAnalyzedResources` request with `analyzerArn` injected from the bound {@link Analyzer}.

## ListFindings

Runtime binding for `access-analyzer:ListFindings`.

Lists the analyzer's external-access findings (V1 API — prefer {@link
ListFindingsV2}, which also returns unused-access findings). Provide the
implementation with `Effect.provide(AWS.AccessAnalyzer.ListFindingsHttp)`.
### Reading Findings
**Example:** List Findings (V1)
```typescript
const listFindings = yield* AWS.AccessAnalyzer.ListFindings(analyzer);
const page = yield* listFindings({ maxResults: 50 });
```

@binding

## ListFindings.Request

`ListFindings` request with `analyzerArn` injected from the bound {@link Analyzer}.

## ListFindingsV2

Runtime binding for the `ListFindingsV2` operation (IAM action
`access-analyzer:ListFindings` — shared with the V1 API).

Lists the analyzer's findings (external-access and unused-access), with
optional filter and sort criteria. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.ListFindingsV2Http)`.
### Reading Findings
**Example:** List Active Findings
```typescript
// init — bind the operation to the analyzer
const listFindings = yield* AWS.AccessAnalyzer.ListFindingsV2(analyzer);

// runtime — page through active findings
const page = yield* listFindings({
  filter: { status: { eq: ["ACTIVE"] } },
  maxResults: 50,
});
```

@binding

## ListFindingsV2.Request

`ListFindingsV2` request with `analyzerArn` injected from the bound {@link Analyzer}.

## ListPolicyGenerations

Runtime binding for `access-analyzer:ListPolicyGenerations`.

Lists the account's recent policy-generation jobs. Provide the
implementation with
`Effect.provide(AWS.AccessAnalyzer.ListPolicyGenerationsHttp)`.
### Policy Generation
**Example:** List Policy Generations
```typescript
const listGenerations =
  yield* AWS.AccessAnalyzer.ListPolicyGenerations();
const page = yield* listGenerations();
```

@binding

## StartPolicyGeneration

Runtime binding for `access-analyzer:StartPolicyGeneration`.

Starts generating a least-privilege policy for a principal from its access
activity (optionally a CloudTrail trail). Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.StartPolicyGenerationHttp)`.
### Policy Generation
**Example:** Generate a Policy for a Role
```typescript
const startGeneration =
  yield* AWS.AccessAnalyzer.StartPolicyGeneration();
const { jobId } = yield* startGeneration({
  policyGenerationDetails: { principalArn: roleArn },
});
```

@binding

## StartResourceScan

Runtime binding for `access-analyzer:StartResourceScan`.

Immediately rescans a resource's policy instead of waiting for the
analyzer's periodic scan. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.StartResourceScanHttp)`.
### Scanning Resources
**Example:** Rescan a Bucket After a Policy Change
```typescript
const startScan = yield* AWS.AccessAnalyzer.StartResourceScan(analyzer);
yield* startScan({ resourceArn: bucket.bucketArn });
```

@binding

## StartResourceScan.Request

`StartResourceScan` request with `analyzerArn` injected from the bound {@link Analyzer}.

## UpdateFindings

Runtime binding for `access-analyzer:UpdateFindings`.

Archives or reactivates findings by id or by the resource they were
generated for. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.UpdateFindingsHttp)`.
### Managing Findings
**Example:** Archive Findings
```typescript
const updateFindings = yield* AWS.AccessAnalyzer.UpdateFindings(analyzer);
yield* updateFindings({ status: "ARCHIVED", ids: [findingId] });
```

@binding

## UpdateFindings.Request

`UpdateFindings` request with `analyzerArn` injected from the bound {@link Analyzer}.

## ValidatePolicy

Runtime binding for `access-analyzer:ValidatePolicy`.

Validates a policy document against IAM policy grammar and best practices,
returning findings with fix suggestions. Provide the implementation with
`Effect.provide(AWS.AccessAnalyzer.ValidatePolicyHttp)`.
### Validating Policies
**Example:** Validate an Identity Policy
```typescript
// init — account-level, no resource argument
const validatePolicy = yield* AWS.AccessAnalyzer.ValidatePolicy();

// runtime
const result = yield* validatePolicy({
  policyDocument: JSON.stringify(policy),
  policyType: "IDENTITY_POLICY",
});
```

@binding
