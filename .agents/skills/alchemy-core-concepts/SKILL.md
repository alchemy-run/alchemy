---
name: alchemy-core-concepts
description: Understand Alchemy's model and repository layout.
---

# Alchemy Core Concepts

## When to use

Load before changing architecture, resources, bindings, stacks, or repository structure.

# Concepts

- **Cloud Provider** - a cloud provider that offers a set of Services, e.g. AWS, Azure, GCP, Cloudflare, Stripe, Planetscale, Neon, etc.
- **Service** - a collection of Resources, Functions, and Bindings offered by a Cloud Provider.
- **Resource** - a named entity that is configuted with "Input Properties" and produces "Output Attributes". May or may not have Binding Contract.
- **Input Properties** - the properties passed as input to configure a Resource. Otherwise known as the "desired state" of the Resource.
- **Output Attributes** - the attributes produced by a Resource. Otherwise known as the "current state" of the Resource.
- **Stable Properties** - properties that are not affected by an Update, e.g. the ID or ARN of a Resource.
- **Function** (aka. **Runtime**) - a special kind of Resource that includes a runtime implementation expressed as a Function producing an `Effect<A, Err, Req>`. The `Req` type captures runtime dependencies, from which Infrastructure Dependencies are inferred.
- **Resource Provider** (see [Provider](../../../packages/alchemy/src/Provider.ts))

A Resource Provider implements the following Lifecycle Operations:

- **Diff** - compares new props with old props and determines if the Resource needs to be updated or replaced. For updates, it can also specify a list of Stable Properties that will not be changed by the update.
- **Read** - reads the current state of a Resource and returns the current Output Attributes. May return `Unowned(attrs)` to signal an existing-but-foreign resource that the engine should refuse to take over unless `--adopt` is set.
- **Pre-Create** - an optional operation that creates a stub of a Resource before reconcile runs. Used to resolve circular dependencies — e.g. Function A and B depend on each other, so we create a stub of Function A first and then `reconcile` later wires up the real dependency.
- **Reconcile** - converges a Resource's actual cloud state to the desired state described by the new Input Properties. Called for both first-time provisioning and subsequent updates. The provider receives `output` (current Attributes) and `olds` (previous Props) which may both be `undefined` on a greenfield create, both defined on an update, or `output !== undefined && olds === undefined` on an adoption. See the [Reconciler doctrine](../alchemy-resource-provider/SKILL.md#reconciler-doctrine) for the required shape.
- **Delete** - deletes an existing Resource. It must be designed as idempotent because it is always possible for state persistence to fail after the delete operation is called. If the resource doesn't exist during deletion, it should not be considered an error.
- **Capability** - a runtime requirement of a Function (e.g. require read access to an `R2Bucket`, or `SQS.SendMessage` on a `SQS.Queue`). A Capability is modeled as one or more `Binding.Service`s. Where the underlying API distinguishes access levels, split it into `Read` / `Write` / `ReadWrite` services (see the [binding convention](../alchemy-resource-provider/SKILL.md#readwritereadwrite-binding-convention)); otherwise a single service suffices. Each service typically ships two interchangeable implementations: a native **binding** (`*Binding.layer(resource)`) and an HTTP/token client (`*Http.layer(resource)`). The user chooses which Layer to provide.
- **Binding.Service** - an Effect Service that exposes a `.bind(resource)` method returning a typed runtime client. Its outer (init) Effect resolves the host Function/Worker and its environment, then registers the deploy-time binding — environment variables, IAM policy statements (AWS), or a native Cloudflare binding — by calling ``host.bind`${resource}`(data)``, guarded by `!globalThis.__ALCHEMY_RUNTIME__` so it is a no-op once running inside the deployed Function/Worker. Provided as a Layer on the **Function/Worker** Effect so it gets bundled into the Lambda/Worker. See [Binding](../../../packages/alchemy/src/Binding.ts).
- **Binding** - data attached to a target Function/Worker via ``host.bind`${resource}`(data)`` from inside a `Binding.Service`. The binding data is collected on the Stack during plan/deploy. Bindings enable circular references between Resources — e.g. a capability binds `{ policyStatements: [...] }` (AWS) or `{ bindings: [...] }` (Cloudflare) onto the host. The Resource Provider then receives the resolved binding data in its `reconcile` lifecycle operation via the `bindings` parameter.
- **Binding Contract** - the shape of data a Resource accepts from Bindings. For example, a Lambda Function accepts `{ env?: Record<string, any>, policyStatements?: PolicyStatement[] }` because it needs environment variables and IAM policies. A Cloudflare Worker accepts `{ bindings: Worker.Binding[] }` for its native binding system. The Binding Contract is declared as the fourth type parameter on the `Resource` interface. See [Lambda Function](../../../packages/alchemy/src/AWS/Lambda/Function.ts) and [Cloudflare Worker](../../../packages/alchemy/src/Cloudflare/Workers/Worker.ts).
- **Dependency** - Resources depend on other Resources through two mechanisms:
  - Output Properties of one Resource passed as Input Properties to another Resource (non-circular, directed acyclic graph)
  - Bindings that attach data (IAM policies, env vars, Cloudflare bindings) from one Resource to another, enabling circular references between Resources.
- **Output** - a reference to (or derived from) a Resource's "Output Attributes". E.g. Bucket.bucketArn
- **Stack** - a collection of Resources, Functions, and Bindings that are deployed together.
- **Stack Name** - the name of a Stack, e.g. `my-stack`
- **Stage** - the stage of a Stack, e.g. `dev`, `prod`, `dev-sam`
- **Stack Instance** - a deployed instance of a Stack+Stage
- **Resource Type** - the type of a Resource, e.g. `Bucket`, `Instance`
- **Physical Name** - a unique name for a Resource, e.g. `my-bucket-1234567890`. It is usually best to generate them using the built-in createPhysicalName utility function which generates
- **Logical ID** - the logical ID identifying a resource within a Stack, e.g. `my-bucket`. It is stable across creates, updates, deletes and replaces.
- **Instance ID** - a unique identifier for an instance of a Resource. It is stable across creates, updates and deletes. It changes when a resource is replaced. It is truncated and used as the suffix of the Physical Name.
- **Event Source** - a special kind of Binding between a Function and a Resource that produces events that invoke the Function, e.g. `SQS.QueueEventSource`. Implemented as a `Binding.Service` whose init Effect both registers the runtime event listener on the host and, at deploy time, yields the event-source mapping resource (or calls the cloud provider API to create/update it).
- **Replacement** - the process of replacing a Resource with a new one. A new one is created, downstream dependencies are updated with the new reference, and then the old one is deleted. Or, the old one is deleted first and then the new one is created.
- **Dependency Violation** - an error that some APIs call when an operation cannot be performed because a dependency is not met. E.g. you cannot delete an EIP until the NAT Gateway it is attached to is deleted. Lifecycle operations typically retry Dependency Violations.
- **Eventual Consistency** - create/update/delete operations can be eventually consistent leading to a variety of failure modes. For example, a Resource may be created but not yet available for use, or a Resource may be deleted but still appear in the console. Errors caused by eventual consistency should be retried, and lifecycle operations/tests should be carefully designed to wait for consistency before proceeding.
- **Retryable Error** - an error that can be retried. E.g. a Dependency Violation, Eventual Consistency Error, Transient Failure, etc.
- **Non-Retryable Error** - an error that cannot be retried. E.g. a Validation Error, Authorization Error, etc.
- **Retry Policy** - a policy for retrying errors. E.g. a fixed delay, exponential backoff, max retries, while some condition is true, or until some condition is true/false, etc.

# File System Conventions

First-class sibling repositories we maintain live in `submodules/`:

- `submodules/distilled` — generated Effect SDKs (workspace packages). Initialized by `git submodule update --init`.
- `submodules/floci` — our fork of the local AWS emulator. Skipped by default; fetch with `git submodule update --init --checkout -- submodules/floci`.

Each Service's Resources follow the same pattern. Resource contract and provider are co-located in the same file. Each Capability lives in its own file(s) named after the capability and access level (`Binding.Service` contract + the `*Binding` / `*Http` implementations).

```sh
# source files
packages/alchemy/src/{Cloud}/{Service}/index.ts         # re-exports resources, capability contracts, and impl layers
packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts    # resource contract + resource provider
packages/alchemy/src/{Cloud}/{Service}/{Capability}.ts  # Binding.Service contract + runtime client interface
# test files
packages/alchemy/test/{Cloud}/{Service}/{Resource}.test.ts
# docs (auto-generated from source-code JSDoc - DO NOT manually edit)
website/src/content/docs/providers/{Cloud}/{Resource}.md  # API reference, generated by `pnpm docs:gen`
```

A capability that exposes distinct access levels is split into a contract per level plus interchangeable native-binding and HTTP implementations, with shared scaffolding kept in *un-exported* helper files (see the [binding convention](../alchemy-resource-provider/SKILL.md#readwritereadwrite-binding-convention)). For example, the Cloudflare R2 bucket capability:

```sh
packages/alchemy/src/Cloudflare/R2/BucketTypes.ts          # shared types + error (exported)
packages/alchemy/src/Cloudflare/R2/BucketRead.ts           # BucketRead Binding.Service + ReadBucketClient (exported)
packages/alchemy/src/Cloudflare/R2/BucketWrite.ts          # BucketWrite Binding.Service + WriteBucketClient (exported)
packages/alchemy/src/Cloudflare/R2/BucketReadWrite.ts      # BucketReadWrite Binding.Service + ReadWriteBucketClient (exported)
packages/alchemy/src/Cloudflare/R2/BucketBinding.ts        # shared worker-binding scaffolding (NOT exported from index)
packages/alchemy/src/Cloudflare/R2/BucketReadBinding.ts    # ReadBucketBinding layer + makeRead (exported)
packages/alchemy/src/Cloudflare/R2/BucketWriteBinding.ts   # WriteBucketBinding layer + makeWrite (exported)
packages/alchemy/src/Cloudflare/R2/BucketReadWriteBinding.ts # ReadWriteBucketBinding layer (exported)
packages/alchemy/src/Cloudflare/R2/BucketHttp.ts           # shared HTTP/token scaffolding (NOT exported from index)
packages/alchemy/src/Cloudflare/R2/BucketReadHttp.ts       # ReadBucketHttp layer (exported)
packages/alchemy/src/Cloudflare/R2/BucketWriteHttp.ts      # WriteBucketHttp layer (exported)
packages/alchemy/src/Cloudflare/R2/BucketReadWriteHttp.ts  # ReadWriteBucketHttp layer (exported)
```

Examples of actual paths:

```sh
packages/alchemy/src/AWS/S3/Bucket.ts          # S3 Bucket resource + provider
packages/alchemy/src/AWS/S3/GetObject.ts       # S3 GetObject capability (Binding.Service)
packages/alchemy/src/AWS/S3/PutObject.ts       # S3 PutObject capability (Binding.Service)
packages/alchemy/src/AWS/SQS/Queue.ts          # SQS Queue resource + provider
packages/alchemy/src/AWS/SQS/SendMessage.ts    # SQS SendMessage capability
packages/alchemy/src/AWS/Kinesis/Stream.ts     # Kinesis Stream resource + provider
packages/alchemy/src/AWS/Kinesis/PutRecord.ts  # Kinesis PutRecord capability
packages/alchemy/src/AWS/Lambda/Function.ts    # Lambda Function resource + provider
packages/alchemy/src/AWS/DynamoDB/Table.ts     # DynamoDB Table resource + provider
packages/alchemy/src/AWS/DynamoDB/GetItem.ts   # DynamoDB GetItem capability
packages/alchemy/src/AWS/EC2/Vpc.ts            # VPC resource + provider
packages/alchemy/src/AWS/EC2/Subnet.ts         # Subnet resource + provider
```
