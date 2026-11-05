# `<Service>.json`

Each service's config records the decisions the generator can't derive.
The types are `ServiceConfig`, `ResourceConfig`, and `ProbeConfig` in
`scripts/generate-gcp-bindings.ts`; their JSDoc is authoritative. This
page groups the keys by the question each one answers.

A minimal config:

```json
{
  "discovery": "storageinsights-v1",
  "module": "storageinsights_v1",
  "resources": {
    "ReportConfig": { "pattern": "projects/*/locations/*/reportConfigs/*" }
  },
  "probes": {
    "resources": { "ReportConfig": "ProbeReportConfig" },
    "enable": ["storageinsights.googleapis.com"]
  }
}
```

## Which API

| Key | |
| --- | --- |
| `discovery` | the discovery doc in distilled's spec mirror (`pubsub-v1`) |
| `module` | the distilled module (`pubsub_v1`) |
| `unstable` | import from `@distilled.cloud/gcp/unstable/…` |
| `permissionService` | the API's IAM permission prefix when it isn't the discovery name (`workflowexecutions` checks `workflows.*`) |
| `apis` | more `{ discovery, module, … }` whose methods bind to the same resources (Bigtable admin + data) |
| `auditServices` | `serviceName`s the audit logs carry, when they aren't the APIs' hosts |

## What a method targets

`resources` maps a resource key to how its methods are recognized. A
method binds to the resource whose `pattern` its path matches; no match
makes it a call on the project.

| `resources.<Key>` | |
| --- | --- |
| `pattern` | full-name shape, `projects/*/topics/*`; the only required key |
| `iamKind` | `GcpIamResourceKind` of the resource's own IAM policy; omitted, grants go on the project |
| `scopeByCondition` | no resource policy: grant on the project under an IAM Condition matching this resource (Firestore) |
| `attributes` | for split path parameters (`b/{bucket}`): the attribute filling each `*` |
| `nameAttribute` | the attribute grants target when it isn't `name` (`bucketName`) |
| `fields` | request fields filled from the resource (a BigQuery job's `location`) |
| `collection` | the discovery collection managing it, when not the pattern's last (`regionDisks`) |
| `lifecycleOnly` | only its create/update/delete belong to it; its other methods bind through the parent |
| `type`, `typeName`, `file` | when the resource isn't `GCP.<Svc>.<Key>` in `<Key>.ts` |
| `auditName`, `noAuditLogs` | the audit-log event source's resource name, or why there is none |

Service-level keys that reshape the target:

| Key | |
| --- | --- |
| `append` | method → fixed path after the bound name (Firestore's `/documents`) |
| `suffix` | method → `[separator, field]` after the name (`schemas/s@<revisionId>`) |
| `childFields` | child collection → the request field naming its member (FHIR `resourceType`) |
| `grantOn` | method → `{ attribute, iamKind }`: the permission is checked on another resource the bound one names (a subscription's `topic`) |
| `projectCalls` | methods that are project calls even though they create a configured kind (`jobs.insert`) |
| `noProjectBindings` | generate no project-level bindings |

## What it is granted

The generator derives `<service>.<collection>.<verb>` and grants the
smallest predefined role holding it, from `roles.json`.

| Key | |
| --- | --- |
| `permissions` | method id → the permission actually checked (`storage.objects.insert` → `storage.objects.create`) |
| `permissionCollections` | collection → the collection permissions are named after (`regionDisks` → `disks`) |
| `verbPermissions` | verb → the verb checked (`resize` → `update`) |
| `defaultPermission` | when no permission resolves (billing-only APIs: `serviceusage.services.use`) |
| `roles` | permission or method → role, when the smallest is a bad fit; a list grants the rest on the project |
| `projectGrant` | method → why the permission is only honoured on the project |

## Whether, and as what, it is a binding

| Key | |
| --- | --- |
| `skip` | method id → why it isn't a binding |
| `names` | derived binding name → the name to use |

## How it is probed

`probes` makes the generator write `test/GCP/<Svc>/Generated.test.ts`
and a Cloud Run host (`fixtures/generated-host.ts`) that calls every
binding with placeholder arguments. Every call must be authorized: a
`NotFound` or a success passes, a `PermissionDenied` fails.

| `probes.` | |
| --- | --- |
| `resources` | resource key → the `fixtures/generated-resources.ts` export that deploys one |
| `enable` | APIs to enable before the host deploys (left enabled on destroy) |
| `args` | binding → the request it is called with, replacing the placeholder |
| `location`, `locations` | where probes call when `us-central1` doesn't serve (`global`, a zone) |
| `skip` | binding → why it isn't called; every probe that would write to the project |
| `untestable` | resource, `"project"`, or `"*"` → why it can't run on the testing project |
| `allowedOutcomes` | error tag → why a read may answer it and still be authorized |
| `ambiguousTags` | error tag the API returns for both missing and denied; retried, then accepted |
| `coveredBy` | a hand-written suite already probes the resource-bound bindings |
| `networks` | VPC quota slots to hold (`test/GCP/networkQuota.ts`) |
| `deployMinutes` | deploy timeout for slow fixtures |

## Not a config: `roles.json`

`packages/gcp/bindings/roles.json` maps every permission to the
smallest predefined role holding it, chosen by `pickRole`. It is
generated (`--refresh-roles`, needs `gcloud`); override a choice with
`roles` in the service config, never by editing it.
