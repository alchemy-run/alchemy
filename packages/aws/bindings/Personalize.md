<!-- Docs for the generated AWS.Personalize bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateBatchInferenceJob

Runtime binding for `personalize:CreateBatchInferenceJob` — Starts a batch inference job that scores a list of users from S3
against a solution version and writes recommendations back to S3.
Grants `personalize:CreateBatchInferenceJob` on `*` plus
`iam:PassRole` (conditioned to `personalize.amazonaws.com`) for the
data-access role the service assumes to read/write the buckets.
Provide the implementation with
`Effect.provide(AWS.Personalize.CreateBatchInferenceJobHttp)`.

### Batch Inference
**Example:** Score Users in Batch
```typescript
// init
const createBatchInferenceJob = yield* Personalize.CreateBatchInferenceJob();

const { batchInferenceJobArn } = yield* createBatchInferenceJob({
  jobName: "nightly-scores",
  solutionVersionArn,
  jobInput: { s3DataSource: { path: "s3://bucket/users.json" } },
  jobOutput: { s3DataDestination: { path: "s3://bucket/scores/" } },
  roleArn: batchRoleArn,
});
```

@binding

## CreateCampaign

Runtime binding for `personalize:CreateCampaign` — Deploys a trained solution version as a live campaign that serves
real-time recommendations — the final step of the MLOps loop.
Provide the implementation with
`Effect.provide(AWS.Personalize.CreateCampaignHttp)`.

### Retraining Loop
**Example:** Deploy a Campaign
```typescript
// init
const createCampaign = yield* Personalize.CreateCampaign();

const { campaignArn } = yield* createCampaign({
  name: "recommendations",
  solutionVersionArn,
});
```

@binding

## CreateDatasetImportJob

Runtime binding for `personalize:CreateDatasetImportJob` — Starts a bulk import of training data from S3 into a dataset — the
first step of the MLOps retraining loop. Grants
`personalize:CreateDatasetImportJob` on `*` plus `iam:PassRole`
(conditioned to `personalize.amazonaws.com`) for the data-access role
the service assumes to read the S3 bucket.
Provide the implementation with
`Effect.provide(AWS.Personalize.CreateDatasetImportJobHttp)`.

### Retraining Loop
**Example:** Import Training Data
```typescript
// init
const createDatasetImportJob = yield* Personalize.CreateDatasetImportJob();

const { datasetImportJobArn } = yield* createDatasetImportJob({
  jobName: "nightly-import",
  datasetArn,
  dataSource: { dataLocation: "s3://training-bucket/interactions.csv" },
  roleArn: importRoleArn,
});
```

@binding

## CreateSolution

Runtime binding for `personalize:CreateSolution` — Creates a solution (a recipe + configuration to train models with)
for a dataset group — set `performAutoTraining` to keep models fresh
automatically.
Provide the implementation with
`Effect.provide(AWS.Personalize.CreateSolutionHttp)`.

### Retraining Loop
**Example:** Create a Solution
```typescript
// init
const createSolution = yield* Personalize.CreateSolution();

const { solutionArn } = yield* createSolution({
  name: "user-personalization",
  recipeArn: "arn:aws:personalize:::recipe/aws-user-personalization",
  datasetGroupArn,
});
```

@binding

## CreateSolutionVersion

Runtime binding for `personalize:CreateSolutionVersion` — Trains a new model (solution version) for an existing solution — the
retraining step of the MLOps loop, typically run on a schedule after
fresh data is imported.
Provide the implementation with
`Effect.provide(AWS.Personalize.CreateSolutionVersionHttp)`.

### Retraining Loop
**Example:** Retrain a Solution
```typescript
// init
const createSolutionVersion = yield* Personalize.CreateSolutionVersion();

const { solutionVersionArn } = yield* createSolutionVersion({
  solutionArn,
  trainingMode: "UPDATE",
});
```

@binding

## DescribeBatchInferenceJob

Runtime binding for `personalize:DescribeBatchInferenceJob` — Polls a batch inference job for completion — pairs with
{@link CreateBatchInferenceJob}.
Provide the implementation with
`Effect.provide(AWS.Personalize.DescribeBatchInferenceJobHttp)`.

### Batch Inference
**Example:** Poll a Batch Job
```typescript
// init
const describeBatchInferenceJob = yield* Personalize.DescribeBatchInferenceJob();

const { batchInferenceJob } = yield* describeBatchInferenceJob({
  batchInferenceJobArn,
});
const done = batchInferenceJob?.status === "ACTIVE";
```

@binding

## DescribeCampaign

Runtime binding for `personalize:DescribeCampaign` — Reads a campaign's status and the solution version it serves — used to
confirm a campaign update finished before switching traffic.
Provide the implementation with
`Effect.provide(AWS.Personalize.DescribeCampaignHttp)`.

### Retraining Loop
**Example:** Poll a Campaign Update
```typescript
// init
const describeCampaign = yield* Personalize.DescribeCampaign();

const { campaign } = yield* describeCampaign({ campaignArn });
const live = campaign?.status === "ACTIVE";
```

@binding

## DescribeDatasetImportJob

Runtime binding for `personalize:DescribeDatasetImportJob` — Polls a bulk dataset import job for completion — pairs with
{@link CreateDatasetImportJob} in the MLOps retraining loop.
Provide the implementation with
`Effect.provide(AWS.Personalize.DescribeDatasetImportJobHttp)`.

### Retraining Loop
**Example:** Poll an Import Job
```typescript
// init
const describeDatasetImportJob = yield* Personalize.DescribeDatasetImportJob();

const { datasetImportJob } = yield* describeDatasetImportJob({
  datasetImportJobArn,
});
const done = datasetImportJob?.status === "ACTIVE";
```

@binding

## DescribeSolutionVersion

Runtime binding for `personalize:DescribeSolutionVersion` — Polls a solution version for training completion — pairs with
{@link CreateSolutionVersion} in the MLOps retraining loop.
Provide the implementation with
`Effect.provide(AWS.Personalize.DescribeSolutionVersionHttp)`.

### Retraining Loop
**Example:** Poll a Training Run
```typescript
// init
const describeSolutionVersion = yield* Personalize.DescribeSolutionVersion();

const { solutionVersion } = yield* describeSolutionVersion({
  solutionVersionArn,
});
const trained = solutionVersion?.status === "ACTIVE";
```

@binding

## GetActionRecommendations

Runtime binding for `personalize:GetActionRecommendations` — Returns a list of recommended actions (next best action) for a user
from a campaign backed by the NEXT_BEST_ACTION recipe. Campaign ARNs
are chosen at runtime, so the binding takes no arguments and grants
`personalize:GetActionRecommendations` on `*`.
Provide the implementation with
`Effect.provide(AWS.Personalize.GetActionRecommendationsHttp)`.

### Serving Recommendations
**Example:** Recommend Actions for a User
```typescript
// init
const getActionRecommendations = yield* Personalize.GetActionRecommendations();

const { actionList } = yield* getActionRecommendations({
  campaignArn,
  userId: "user-1",
});
```

@binding

## GetPersonalizedRanking

Runtime binding for `personalize:GetPersonalizedRanking` — Re-ranks a caller-supplied list of items for a user using a campaign
backed by the Personalized-Ranking recipe. Campaign ARNs are chosen at
runtime, so the binding takes no arguments and grants
`personalize:GetPersonalizedRanking` on `*`.
Provide the implementation with
`Effect.provide(AWS.Personalize.GetPersonalizedRankingHttp)`.

### Serving Recommendations
**Example:** Rank Items for a User
```typescript
// init
const getPersonalizedRanking = yield* Personalize.GetPersonalizedRanking();

const { personalizedRanking } = yield* getPersonalizedRanking({
  campaignArn,
  userId: "user-1",
  inputList: ["item-1", "item-2", "item-3"],
});
```

@binding

## GetRecommendations

Runtime binding for `personalize:GetRecommendations` — Returns a list of recommended items for a user from a campaign or
domain recommender — the core Personalize serving call. Campaign and
recommender ARNs are chosen at runtime, so the binding takes no
arguments and grants `personalize:GetRecommendations` on `*`.
Provide the implementation with
`Effect.provide(AWS.Personalize.GetRecommendationsHttp)`.

### Serving Recommendations
**Example:** Recommend Items for a User
```typescript
// init
const getRecommendations = yield* Personalize.GetRecommendations();

const { itemList } = yield* getRecommendations({
  campaignArn,
  userId: "user-1",
  numResults: 10,
});
```

@binding

## GetSolutionMetrics

Runtime binding for `personalize:GetSolutionMetrics` — Reads the offline evaluation metrics (precision, coverage, NDCG, …)
of a trained solution version — used to gate deployment on model
quality.
Provide the implementation with
`Effect.provide(AWS.Personalize.GetSolutionMetricsHttp)`.

### Retraining Loop
**Example:** Evaluate a Trained Model
```typescript
// init
const getSolutionMetrics = yield* Personalize.GetSolutionMetrics();

const { metrics } = yield* getSolutionMetrics({ solutionVersionArn });
const ndcg = metrics?.["normalized_discounted_cumulative_gain_at_25"];
```

@binding

## PutActionInteractions

Runtime binding for `personalize:PutActionInteractions`, scoped to one {@link EventTracker} —
Records action-interaction events (Taken, Not Taken, Viewed) for the
NEXT_BEST_ACTION recipe through the bound {@link EventTracker}. Events
stream into the dataset group's Action interactions dataset.
Provide the implementation with
`Effect.provide(AWS.Personalize.PutActionInteractionsHttp)`.

### Streaming Events
**Example:** Record an Action Interaction
```typescript
// init
const putActionInteractions = yield* Personalize.PutActionInteractions(tracker);

yield* putActionInteractions({
  actionInteractions: [{
    actionId: "action-1",
    userId: "user-1",
    sessionId: "session-1",
    eventType: "Taken",
    timestamp: new Date(),
  }],
});
```

@binding

## PutActionInteractions.Request

`PutActionInteractions` request with `trackingId` injected from the bound tracker.

## PutActions

Runtime binding for `personalize:PutActions`, scoped to one {@link Dataset} —
Adds or updates actions incrementally in the bound Actions
{@link Dataset} for the NEXT_BEST_ACTION recipe.
Provide the implementation with
`Effect.provide(AWS.Personalize.PutActionsHttp)`.

### Incremental Imports
**Example:** Upsert an Action
```typescript
// init
const putActions = yield* Personalize.PutActions(actionsDataset);

yield* putActions({ actions: [{ actionId: "action-1" }] });
```

@binding

## PutActions.Request

`PutActions` request with `datasetArn` injected from the bound dataset.

## PutEvents

Runtime binding for `personalize:PutEvents`, scoped to one {@link EventTracker} —
Records item-interaction events (clicks, views, purchases, …) in real
time through the bound {@link EventTracker}. Events stream into the
dataset group's Interactions dataset and are used by recommenders as
they happen.
Provide the implementation with
`Effect.provide(AWS.Personalize.PutEventsHttp)`.

### Streaming Events
**Example:** Record a Click Event
```typescript
// init
const putEvents = yield* Personalize.PutEvents(tracker);

yield* putEvents({
  sessionId: "session-1",
  userId: "user-1",
  eventList: [{ eventType: "click", itemId: "item-42", sentAt: new Date() }],
});
```

@binding

## PutEvents.Request

`PutEvents` request with `trackingId` injected from the bound tracker.

## PutItems

Runtime binding for `personalize:PutItems`, scoped to one {@link Dataset} —
Adds or updates items incrementally in the bound Items {@link Dataset}
— the streaming alternative to a bulk dataset import job for keeping
the catalog fresh.
Provide the implementation with
`Effect.provide(AWS.Personalize.PutItemsHttp)`.

### Incremental Imports
**Example:** Upsert an Item
```typescript
// init
const putItems = yield* Personalize.PutItems(itemsDataset);

yield* putItems({
  items: [{
    itemId: "item-42",
    properties: JSON.stringify({ category: "books" }),
  }],
});
```

@binding

## PutItems.Request

`PutItems` request with `datasetArn` injected from the bound dataset.

## PutUsers

Runtime binding for `personalize:PutUsers`, scoped to one {@link Dataset} —
Adds or updates users incrementally in the bound Users {@link Dataset}
— the streaming alternative to a bulk dataset import job for keeping
user metadata fresh.
Provide the implementation with
`Effect.provide(AWS.Personalize.PutUsersHttp)`.

### Incremental Imports
**Example:** Upsert a User
```typescript
// init
const putUsers = yield* Personalize.PutUsers(usersDataset);

yield* putUsers({
  users: [{
    userId: "user-1",
    properties: JSON.stringify({ membership: "gold" }),
  }],
});
```

@binding

## PutUsers.Request

`PutUsers` request with `datasetArn` injected from the bound dataset.

## UpdateCampaign

Runtime binding for `personalize:UpdateCampaign` — Points a live campaign at a newly trained solution version (or adjusts
its provisioned TPS) — the deploy step of the MLOps retraining loop.
Provide the implementation with
`Effect.provide(AWS.Personalize.UpdateCampaignHttp)`.

### Retraining Loop
**Example:** Deploy a New Model Version
```typescript
// init
const updateCampaign = yield* Personalize.UpdateCampaign();

yield* updateCampaign({ campaignArn, solutionVersionArn });
```

@binding
