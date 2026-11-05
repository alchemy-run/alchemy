<!-- Docs for the generated AWS.AppRegistry bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetApplication

Runtime binding for `servicecatalog:GetApplication`.

Reads the bound application's metadata — description, tags, the
`awsApplication` tag value, integrations, and the associated resource
count. Provide the implementation with
`Effect.provide(AWS.AppRegistry.GetApplicationHttp)`.
### Reading Application Metadata
**Example:** Read the Application at Runtime
```typescript
// init — bind the operation to the application
const getApplication = yield* AWS.AppRegistry.GetApplication(app);

// runtime
const details = yield* getApplication();
console.log(details.name, details.associatedResourceCount);
```

@binding

## GetAssociatedResource

Runtime binding for `servicecatalog:GetAssociatedResource`.

Reads one resource associated with the bound application, including its
application-tag sync status. Provide the implementation with
`Effect.provide(AWS.AppRegistry.GetAssociatedResourceHttp)`.
### Reading Associated Resources
**Example:** Get an Associated CloudFormation Stack
```typescript
// init — bind the operation to the application
const getAssociatedResource =
  yield* AWS.AppRegistry.GetAssociatedResource(app);

// runtime
const result = yield* getAssociatedResource({
  resourceType: "CFN_STACK",
  resource: "my-stack",
});
console.log(result.resource?.arn);
```

@binding

## GetAssociatedResource.Request

`GetAssociatedResource` request with `application` injected from the bound {@link Application}.

## GetAttributeGroup

Runtime binding for `servicecatalog:GetAttributeGroup`.

Reads the bound attribute group's user-defined JSON metadata (the
`attributes` string) along with its description and tags — the primary
way for a running function to consume AppRegistry metadata. Provide the
implementation with `Effect.provide(AWS.AppRegistry.GetAttributeGroupHttp)`.
### Reading Attribute Group Metadata
**Example:** Read Attributes at Runtime
```typescript
// init — bind the operation to the attribute group
const getAttributeGroup = yield* AWS.AppRegistry.GetAttributeGroup(group);

// runtime
const details = yield* getAttributeGroup();
const attributes = JSON.parse(details.attributes ?? "{}");
```

@binding

## ListApplications

Runtime binding for `servicecatalog:ListApplications`.

Enumerates all AppRegistry applications in the account — useful in
discovery/dashboard functions that inventory registered applications.
Account-level: no resource argument. Provide the implementation with
`Effect.provide(AWS.AppRegistry.ListApplicationsHttp)`.
### Discovering Applications
**Example:** List the Account's Applications
```typescript
// init — account-level, no resource argument
const listApplications = yield* AWS.AppRegistry.ListApplications();

// runtime
const page = yield* listApplications({ maxResults: 20 });
for (const app of page.applications ?? []) {
  console.log(app.name, app.id);
}
```

@binding

## ListAssociatedAttributeGroups

Runtime binding for `servicecatalog:ListAssociatedAttributeGroups`.

Pages through the IDs of the attribute groups associated with the bound
application. Provide the implementation with
`Effect.provide(AWS.AppRegistry.ListAssociatedAttributeGroupsHttp)`.
### Reading Attribute Groups
**Example:** List the Application's Attribute Group IDs
```typescript
// init — bind the operation to the application
const listAssociatedAttributeGroups =
  yield* AWS.AppRegistry.ListAssociatedAttributeGroups(app);

// runtime
const page = yield* listAssociatedAttributeGroups({ maxResults: 25 });
console.log(page.attributeGroups);
```

@binding

## ListAssociatedAttributeGroups.Request

`ListAssociatedAttributeGroups` request with `application` injected from the bound {@link Application}.

## ListAssociatedResources

Runtime binding for `servicecatalog:ListAssociatedResources`.

Pages through the resources associated with the bound application.
Provide the implementation with
`Effect.provide(AWS.AppRegistry.ListAssociatedResourcesHttp)`.
### Reading Associated Resources
**Example:** List the Application's Resources
```typescript
// init — bind the operation to the application
const listAssociatedResources =
  yield* AWS.AppRegistry.ListAssociatedResources(app);

// runtime
const page = yield* listAssociatedResources({ maxResults: 25 });
console.log(page.resources?.map((r) => r.arn));
```

@binding

## ListAssociatedResources.Request

`ListAssociatedResources` request with `application` injected from the bound {@link Application}.

## ListAttributeGroups

Runtime binding for `servicecatalog:ListAttributeGroups`.

Enumerates all AppRegistry attribute groups the caller can access —
useful in discovery/governance functions that inventory application
metadata. Account-level: no resource argument. Provide the implementation
with `Effect.provide(AWS.AppRegistry.ListAttributeGroupsHttp)`.
### Discovering Attribute Groups
**Example:** List the Account's Attribute Groups
```typescript
// init — account-level, no resource argument
const listAttributeGroups = yield* AWS.AppRegistry.ListAttributeGroups();

// runtime
const page = yield* listAttributeGroups({ maxResults: 20 });
for (const group of page.attributeGroups ?? []) {
  console.log(group.name, group.id);
}
```

@binding

## ListAttributeGroupsForApplication

Runtime binding for `servicecatalog:ListAttributeGroupsForApplication`.

Pages through the details (ID, ARN, name) of the attribute groups
associated with the bound application. Provide the implementation with
`Effect.provide(AWS.AppRegistry.ListAttributeGroupsForApplicationHttp)`.
### Reading Attribute Groups
**Example:** List the Application's Attribute Group Details
```typescript
// init — bind the operation to the application
const listAttributeGroupsForApplication =
  yield* AWS.AppRegistry.ListAttributeGroupsForApplication(app);

// runtime
const page = yield* listAttributeGroupsForApplication({ maxResults: 25 });
console.log(page.attributeGroupsDetails?.map((g) => g.name));
```

@binding

## ListAttributeGroupsForApplication.Request

`ListAttributeGroupsForApplication` request with `application` injected from the bound {@link Application}.

## SyncResource

Runtime binding for `servicecatalog:SyncResource`.

Re-syncs a resource's AppRegistry system tags (`awsApplication`) with its
associated application — useful in remediation functions that repair
drifted application tags. The caller additionally needs permission to read
and update the target resource itself (e.g. `cloudformation:UpdateStack` +
`tag:GetResources` for a CloudFormation stack); grant those on the host
separately. Provide the implementation with
`Effect.provide(AWS.AppRegistry.SyncResourceHttp)`.
### Syncing Resources
**Example:** Re-sync a CloudFormation Stack's Application Tag
```typescript
// init — account-level, no resource argument
const syncResource = yield* AWS.AppRegistry.SyncResource();

// runtime
const result = yield* syncResource({
  resourceType: "CFN_STACK",
  resource: "my-stack",
});
console.log(result.actionTaken);
```

@binding
