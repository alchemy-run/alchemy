<!-- Docs for the generated AWS.FIS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAction

Runtime binding for `fis:GetAction`.

Reads a single FIS action from the service's action catalog — its
description, parameters, and the targets it applies to (e.g.
`aws:ec2:stop-instances`). Provide the implementation with
`Effect.provide(AWS.FIS.GetActionHttp)`.
### Browsing the Action Catalog
**Example:** Inspect an Action's Parameters
```typescript
// init — account-level binding, no resource argument
const getAction = yield* AWS.FIS.GetAction();

// runtime
const { action } = yield* getAction({ id: "aws:fis:wait" });
console.log(Object.keys(action?.parameters ?? {}));
```

@binding

## GetExperiment

Runtime binding for `fis:GetExperiment`.

Reads a running or finished experiment — its state (`pending`,
`initiating`, `running`, `completed`, `stopped`, `failed`), per-action
progress, and log/report configuration. Experiments are created
dynamically, so this is an account-level binding addressed by experiment
id. Provide the implementation with
`Effect.provide(AWS.FIS.GetExperimentHttp)`.
### Running Experiments
**Example:** Poll an Experiment's State
```typescript
// init — account-level binding, no resource argument
const getExperiment = yield* AWS.FIS.GetExperiment();

// runtime
const { experiment } = yield* getExperiment({ id: experimentId });
console.log(experiment?.state?.status);
```

@binding

## GetExperimentTargetAccountConfiguration

Runtime binding for `fis:GetExperimentTargetAccountConfiguration`.

Reads the target account configuration a multi-account experiment resolved
for a specific account — the role and description FIS uses to act in that
account. Provide the implementation with
`Effect.provide(AWS.FIS.GetExperimentTargetAccountConfigurationHttp)`.
### Multi-Account Experiments
**Example:** Read an Experiment's Target Account
```typescript
// init — account-level binding, no resource argument
const getTargetAccount =
  yield* AWS.FIS.GetExperimentTargetAccountConfiguration();

// runtime
const { targetAccountConfiguration } = yield* getTargetAccount({
  experimentId,
  accountId,
});
console.log(targetAccountConfiguration?.roleArn);
```

@binding

## GetExperimentTemplate

Runtime binding for `fis:GetExperimentTemplate`.

Reads the bound {@link ExperimentTemplate}'s full definition — targets,
actions, stop conditions, log and report configuration — so a runtime
function can inspect the experiment it is about to start. The template id
is injected from the binding. Provide the implementation with
`Effect.provide(AWS.FIS.GetExperimentTemplateHttp)`.
### Inspecting Templates
**Example:** Read the Bound Template's Definition
```typescript
// init — bind the operation to the experiment template
const getExperimentTemplate = yield* AWS.FIS.GetExperimentTemplate(template);

// runtime
const { experimentTemplate } = yield* getExperimentTemplate();
console.log(Object.keys(experimentTemplate?.actions ?? {}));
```

@binding

## GetSafetyLever

Runtime binding for `fis:GetSafetyLever`.

Reads the account's safety lever — the emergency switch that, when
`engaged`, stops all running experiments and prevents new ones from
starting. The account's lever has the well-known id `default`. Provide the
implementation with `Effect.provide(AWS.FIS.GetSafetyLeverHttp)`.
### The Safety Lever
**Example:** Check Whether Experiments Are Halted
```typescript
// init — account-level binding, no resource argument
const getSafetyLever = yield* AWS.FIS.GetSafetyLever();

// runtime
const { safetyLever } = yield* getSafetyLever({ id: "default" });
console.log(safetyLever?.state?.status); // "disengaged"
```

@binding

## GetTargetResourceType

Runtime binding for `fis:GetTargetResourceType`.

Reads a single targetable resource type from the FIS catalog — its
description and the parameters targets of that type accept (e.g.
`aws:ec2:instance`). Provide the implementation with
`Effect.provide(AWS.FIS.GetTargetResourceTypeHttp)`.
### Browsing the Action Catalog
**Example:** Inspect a Target Resource Type
```typescript
// init — account-level binding, no resource argument
const getTargetResourceType = yield* AWS.FIS.GetTargetResourceType();

// runtime
const { targetResourceType } = yield* getTargetResourceType({
  resourceType: "aws:ec2:instance",
});
console.log(targetResourceType?.description);
```

@binding

## ListActions

Runtime binding for `fis:ListActions`.

Enumerates the FIS action catalog — every fault the service can inject
(`aws:ec2:stop-instances`, `aws:ssm:send-command`, `aws:fis:wait`, …).
Provide the implementation with `Effect.provide(AWS.FIS.ListActionsHttp)`.
### Browsing the Action Catalog
**Example:** List Available Fault Actions
```typescript
// init — account-level binding, no resource argument
const listActions = yield* AWS.FIS.ListActions();

// runtime
const { actions } = yield* listActions();
console.log((actions ?? []).map((a) => a.id));
```

@binding

## ListExperimentResolvedTargets

Runtime binding for `fis:ListExperimentResolvedTargets`.

Lists the concrete resources an experiment's targets resolved to — the
exact instances, tasks, or functions the faults were injected into — so a
post-run report can name the blast radius. Provide the implementation with
`Effect.provide(AWS.FIS.ListExperimentResolvedTargetsHttp)`.
### Running Experiments
**Example:** Report an Experiment's Blast Radius
```typescript
// init — account-level binding, no resource argument
const listResolvedTargets = yield* AWS.FIS.ListExperimentResolvedTargets();

// runtime
const { resolvedTargets } = yield* listResolvedTargets({
  experimentId,
});
for (const target of resolvedTargets ?? []) {
  console.log(target.targetName, target.targetInformation);
}
```

@binding

## ListExperimentTargetAccountConfigurations

Runtime binding for `fis:ListExperimentTargetAccountConfigurations`.

Lists the target account configurations a multi-account experiment
resolved — every account the experiment injects faults into. Provide the
implementation with
`Effect.provide(AWS.FIS.ListExperimentTargetAccountConfigurationsHttp)`.
### Multi-Account Experiments
**Example:** List an Experiment's Target Accounts
```typescript
// init — account-level binding, no resource argument
const listTargetAccounts =
  yield* AWS.FIS.ListExperimentTargetAccountConfigurations();

// runtime
const { targetAccountConfigurations } = yield* listTargetAccounts({
  experimentId,
});
console.log(
  (targetAccountConfigurations ?? []).map((c) => c.accountId),
);
```

@binding

## ListExperimentTemplates

Runtime binding for `fis:ListExperimentTemplates`.

Enumerates the account's experiment templates — the catalog a chaos
orchestrator picks its next run from. Provide the implementation with
`Effect.provide(AWS.FIS.ListExperimentTemplatesHttp)`.
### Inspecting Templates
**Example:** List the Account's Templates
```typescript
// init — account-level binding, no resource argument
const listExperimentTemplates = yield* AWS.FIS.ListExperimentTemplates();

// runtime
const { experimentTemplates } = yield* listExperimentTemplates();
console.log((experimentTemplates ?? []).map((t) => t.id));
```

@binding

## ListExperiments

Runtime binding for `fis:ListExperiments`.

Enumerates the account's experiments, optionally filtered to those started
from a specific template — the building block of a chaos-run dashboard or
a guard that refuses to start a new experiment while one is already
running. Provide the implementation with
`Effect.provide(AWS.FIS.ListExperimentsHttp)`.
### Running Experiments
**Example:** Find Running Experiments for a Template
```typescript
// init — account-level binding, no resource argument
const listExperiments = yield* AWS.FIS.ListExperiments();

// runtime
const { experiments } = yield* listExperiments({
  experimentTemplateId: templateId,
});
const running = (experiments ?? []).filter(
  (e) => e.state?.status === "running",
);
```

@binding

## ListTargetResourceTypes

Runtime binding for `fis:ListTargetResourceTypes`.

Enumerates the resource types FIS experiments can target
(`aws:ec2:instance`, `aws:ecs:task`, `aws:rds:cluster`, …). Provide the
implementation with `Effect.provide(AWS.FIS.ListTargetResourceTypesHttp)`.
### Browsing the Action Catalog
**Example:** List Targetable Resource Types
```typescript
// init — account-level binding, no resource argument
const listTargetResourceTypes = yield* AWS.FIS.ListTargetResourceTypes();

// runtime
const { targetResourceTypes } = yield* listTargetResourceTypes();
console.log((targetResourceTypes ?? []).map((t) => t.resourceType));
```

@binding

## StartExperiment

Runtime binding for `fis:StartExperiment`.

Starts a fault-injection experiment from the bound
{@link ExperimentTemplate} — the template's id is injected and the
idempotency `clientToken` is generated automatically. The IAM grant covers
both the template and the `experiment/*` ARN the started experiment is
created under. Provide the implementation with
`Effect.provide(AWS.FIS.StartExperimentHttp)`.
### Running Experiments
**Example:** Start an Experiment from the Bound Template
```typescript
// init — bind the operation to the experiment template
const startExperiment = yield* AWS.FIS.StartExperiment(template);

// runtime
const { experiment } = yield* startExperiment();
console.log(experiment?.id, experiment?.state?.status);
```

@binding

## StopExperiment

Runtime binding for `fis:StopExperiment`.

Stops a running experiment — the manual abort switch for a
chaos-engineering run that a monitoring function decides has gone far
enough. Experiments are created dynamically, so this is an account-level
binding addressed by experiment id. Provide the implementation with
`Effect.provide(AWS.FIS.StopExperimentHttp)`.
### Running Experiments
**Example:** Abort a Running Experiment
```typescript
// init — account-level binding, no resource argument
const stopExperiment = yield* AWS.FIS.StopExperiment();

// runtime
const { experiment } = yield* stopExperiment({ id: experimentId });
console.log(experiment?.state?.status); // "stopping"
```

@binding

## UpdateSafetyLeverState

Runtime binding for `fis:UpdateSafetyLeverState`.

Engages or disengages the account's safety lever — engaging it stops all
running experiments and blocks new ones until it is disengaged, the
account-wide chaos kill switch an ops function flips when a stop condition
outside FIS's view fires. The account's lever has the well-known id
`default`. Provide the implementation with
`Effect.provide(AWS.FIS.UpdateSafetyLeverStateHttp)`.
### The Safety Lever
**Example:** Halt All Experiments
```typescript
// init — account-level binding, no resource argument
const updateSafetyLeverState = yield* AWS.FIS.UpdateSafetyLeverState();

// runtime
yield* updateSafetyLeverState({
  id: "default",
  state: { status: "engaged", reason: "elevated error budget burn" },
});
```

@binding
