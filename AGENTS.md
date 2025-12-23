# alchemy-effect

Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that extends Infrastructure-as-Code (IaC) by combining business logic and infrastructure config into a single, type-safe program expressed as Effects.

It includes a core IaC engine built with Effect. Effect provides the foundation for type-safe, composable, and testable infrastructure programs. It brings errors into the type-system and provides declarative/composable retry logic that ensure proper and reliable handling of failures.

# Concepts

- **Cloud Provider** - a cloud provider that offers a set of Services, e.g. AWS, Azure, GCP, Cloudflare, Stripe, Planetscale, Neon, etc.
- **Service** - a collection of Resources, Functions, and Bindings offered by a Cloud Provider.
- **Resource** - a named entity that is configuted with "Input Properties" and produces "Output Attributes".
- **Input Properties** - the properties passed as input to configure a Resource. Otherwise known as the "desired state" of the Resource.
- **Output Attributes** - the attributes produced by a Resource. Otherwise known as the "current state" of the Resource.
- **Stable Properties** - properties that are not affected by an Update, e.g. the ID or ARN of a Resource.
- **Function** (aka. **Runtime**) - a special kind of Resource that includes a runtime implementation expressed as a Function producing an `Effect<A, Err, Req>`. The `Req` type captures runtime dependencies, from which Infrastructure Dependencies are inferred.
- **Resource Provider** (see [Provider](./alchemy-effect/src/provider.ts))

A Resource Provider implements the following Lifecycle Operations:

- **Diff** - compares new props with old props and determines if the Resource needs to be updated or replaced. For updates, it can also specify a list of Stable Properties that will not be changed by the update.
- **Read** - reads the current state of a Resource and returns the current Output Attributes.
- **Pre-Create** - an optional operation that can be called to create a stub of a Resource before the actual create operation is called. This is useful for resolving circular dependencies since it allows for an empty resoruce to be created and then updated later with its dependencies (e.g. Function A and B depend on each other, so we can create a stub of Function A and then update it with the actual Function B later).
- **Create** - creates a new Resource. It must be designed as idempotent because it is always possible for state persistence to fail after the create operation is called. There are various techniques for resolving idempotency, such as deterministic physical name generation and resource tagging.
- **Update** - updates an existing Resource with new Input Properties.
- **Delete** - deletes an existing Resource. It must be designed as idempotent because it is always possible for state persistence to fail after the delete operation is called. If the resource doesn't exist during deletion, it should not be considered an error.
- **Capability** - a runtime requirement of a Function (e.g. require `SQS.SendMessage` on a `SQS.Queue`, `Messages`). It maps closely to an IAM Policy and Environment variable requirement.
- **Binding** - a declared physical connection between a Function and a Resource to satisfy a Capability, e.g. `SQS.SendMessage(Messages)`
- **Binding Attributes** - the Attributes that a specific Function (Runtime) Resource accepts as input from Bindings. For example, a Lambda Function accepts the following Binding Attributes: `env`, `policyStatements` because it needs to set environment variables and attach IAM policies to the function. A Cloudflare Worker just accepts `env` (bindings) because Cloudflare Workers do not support IAM policies, but do have their own first-class Binding concept.
- **Binding Provider** - see [BindingProvider](./alchemy-effect/src/binding.ts)
  - **Diff** - compares new props with old props and determines if the Binding needs to be updated or replaced.
  - **Preattach** - a pre-attach operation that can be called before the Binding is attached to the Resource. It returns a partial set of the target resource's Binding Attributes because it is not expected for pre-attach to fully populate the Binding Attributes.
  - **Attach** - Actually performs the attachment side-effect if one is needed. Most Bindings are pure (just returning IAM policies and environment variables) but some, such as Event Sources, actually need to call an API like Create or Update Event Source to create the event source.
  - **Postattach** - a post-attach operation that can be called after the Binding is attached to the Resource.
  - **Reattach** - reattaches the Binding to the Resource. This is similar to the Update operation in a Resource Provider. It is expected to update (re-attach) the Binding to the Resource.
  - **Detach** - detaches the Binding from the Resource.
- **Dependency** - Resources depend on other Resources through two mechanisms:
  - Output Properties of one Resource passed as Input Properties to another Resource (non-circular, directed acyclic graph)
  - Bindings (e.g. `SQS.SendMessage(Messages)`) that connect a Function to a Resource to satisfy a Capability (cyclic graph).
- **Output** - a reference to (or derived from) a Resource's "Output Attributes". E.g. Bucket.bucketArn
- **Stack** - a collection of Resources, Functions, and Bindings that are deployed together.
- **Stack Name** - the name of a Stack, e.g. `my-stack`
- **Stage** - the stage of a Stack, e.g. `dev`, `prod`, `dev-sam`
- **Stack Instance** - a deployed instance of a Stack+Stage
- **Resource Type** - the type of a Resource, e.g. `Bucket`, `Instance`
- **Physical Name** - a unique name for a Resource, e.g. `my-bucket-1234567890`. It is usually best to generate them using the built-in createPhysicalName utility function which generates
- **Logical ID** - the logical ID identifying a resource within a Stack, e.g. `my-bucket`. It is stable across creates, updates, deletes and replaces.
- **Instance ID** - a unique identifier for an instance of a Resource. It is stable across creates, updates and deletes. It changes when a resource is replaced. It is truncated and used as the suffix of the Physical Name.
- **Event Source** - a Binding between a Function and a Resource that produces events that invoke the Function, e.g. `SQS.QueueEventSource(Messages)`
- **Replacement** - the process of replacing a Resource with a new one. A new one is created, downstream dependencies are updated with the new reference, and then the old one is deleted. Or, the old one is deleted first and then the new one is created.
- **Dependency Violation** - an error that some APIs call when an operation cannot be performed because a dependency is not met. E.g. you cannot delete an EIP until the NAT Gateway it is attached to is deleted. Lifecycle operations typically retry Dependency Violations.
- **Eventual Consistency** - create/update/delete operations can be eventually consistent leading to a variety of failure modes. For example, a Resource may be created but not yet available for use, or a Resource may be deleted but still appear in the console. Errors caused by eventual consistency should be retried, and lifecycle operations/tests should be carefully designed to wait for consistency before proceeding.
- **Retryable Error** - an error that can be retried. E.g. a Dependency Violation, Eventual Consistency Error, Transient Failure, etc.
- **Non-Retryable Error** - an error that cannot be retried. E.g. a Validation Error, Authorization Error, etc.
- **Retry Policy** - a policy for retrying errors. E.g. a fixed delay, exponential backoff, max retries, while some condition is true, or until some condition is true/false, etc.

# File System Conventions

Each Service's Resources follow the same pattern and have

```sh
# source files
alchemy-effect/src/{cloud}/{service}/index.ts
alchemy-effect/src/{cloud}/{service}/client.ts
alchemy-effect/src/{cloud}/{service}/{resource}.ts
alchemy-effect/src/{cloud}/{service}/{resource}.provider.ts
alchemy-effect/src/{cloud}/{service}/{resource}.{capability}.ts
# test files
alchemy-effect/test/{cloud}/{service}/{resource}.provider.test.ts
# docs
alchemy-effect/docs/{cloud}/{service}/index.md # overview and references to each resource in the service
alchemy-effect/docs/{cloud}/{service}/{resource}.md # documents the usage patterns of a resource. This is not an API reference, it is a use-case oriented guide that focuses on providing snippets of common patterns and best practices. It can link out to the API reference for more detailed information.
alchemy-effect/docs/api/{cloud}/{service}/{resource}.md # API reference for the resource generated from comments in the source code (do not manually edit this file).
```

# Workflow

Development of Alchemy-Effect Resources is heavily pattern based. Each Service has many Resources that each have 0 oor more Capabilities and Event Sources. When working on a new Service, the following steps should be followed.

1. Research the AWS Service and identify its Resources, Identifier Types, Structs, Capabilities, and Event Sources. Refer to the corresponding Terraform Provider, Pulumi Provider, and CloudFormation docs for that service (use the provided tools specifically for searching these docs for services and resources).

Example (abbreviated):

Service: S3

Resources:

- Bucket
- BucketPolicy
- etc.

Bucket Capabilities:

- GetObject
- PutObject
- DeleteObject

Identifier Types:

- Bucket Name
- Bucket ARN

Structs:

- CorsRule
- LifecycleConfiguration

2. Document each of the Resource interfaces in `alchemy-effect/design/{cloud}/{service}/${resource}.md`.

Include the following information:

- ResourceName, e.g. Bucket, Instance, Queue
- Input Properties (for each property: Name, Type, Description, Default Value, Required, Constraints, Replaces: true/false)
- Output Attributes (for each attribute: Name, Type, Description)

3. Document each of the Capabilities and Bindings in `alchemy-effect/design/{cloud}/{service}/${resource}.{capability}.md`.

Include the following information:

- Capability Name, e.g. `GetObject`, `PutObject` (it maps 1:1 with an AWS API)
- Constraints (e.g. `Key`)
- IAM Policies (how the capability maps to an IAM Policy, e.g. Effect: Allow, Action: s3:GetObject, Resource: `arn:aws:s3:::${bucketName}/${Key}`)
- Environment Variables (what environment variables should be added to a Lambda Function so that it can access the capability, e.g. `BUCKET_NAME`, `BUCKET_ARN`, `QUEUE_URL`, `QUEUE_ARN`, etc.)

4. Research and design each of the Lifecycle Operations in `alchemy-effect/design/{cloud}/{service}/${resource}.{operation}.md`.

Each of the following operations are documented in a separate document named `{resource}.{operation}.md`:

- **Diff** - identify which properties are always stable across any update, which properties change conditionally depending on new and old values, which properties trigger a replacement. This is usually just a distinct list, but can sometimes require if-this-then-that logic. Document it explicitly and exhaustively. Cross-reference with AWS CloudFormation, Terraform Provider and Pulumi Provider docs.
- **Read** - determine which API calls are required to read the Output Attributes of a Resource from the Cloud Provider state (otherwise known as refresh or synchronize resource state). This is usually a single Get{Resource} API call, but can be a complex set of calls depending on the Service. Read can also be called without the current Output Attributes because of past state persistence failures. These cases are handled by computing the deterministic Physical Name and looking it up or by searching for Resources using tags (if the Cloud Provider supports it).
- **Pre-Create** - determine if the Resource needs a pre-create operation. This is usually only the case for the special Function/Runtime Resources like AWS Lambda Functions. If it is required, then document which API call(s) should be called and what the empty (unit) input properties are. E.g. a Lambda Function takes a simple script that exports a no-op handler function.
- **Create** - determine which APIs calls are required to create a new instance of a Resource. This can be one or more API calls in a sequence. Include a section dedicated to idempotency and error handling. Does the resource accept a physical name that we can predict to idempotently create a new resource and recover gracefully if it already exists? Or does the resource generate its own ID, in which case we need to use tags to find it? Document the procedure using if-this-then-that logic. Each API call can return errors that should
- **Update** - determine which APIs should be called and in what order to update an existing Resource. Document the procedure using if-this-then-that logic. Each API call can return errors that may need to be retried with a specific Retry Policy. The procedure should be defined conditionally in terms of new Input Properties, old Input Properties and the current Output Attributes.
- **Delete** - determine which APIs should be called and in what order to delete an existing Resource. Delete should be idempotent so that if the resource has already been deleted, it is not considered an error. It is common for deletions to fail because of Dependency Violations or Eventual Consistency Errors. These are not always called Dependency Violations in the API docs, so attention should be paid to investigating each API's possible error codes and how they should be handled by the Delete operation. Should we retry for a period of time, indefinitely, or fail immediately?

5. Research and design the test cases for each resource in `alchemy-effect/design/{cloud}/{service}/${resource}.test.md`. Test cases can be single or multi-step. Single-step test cases are just testing a single create success or failure mode. Multi-step cases are testing a sequence of operations, starting with create and then updating or replacing the resource multiple times. Test cases should be designed to be exhaustive and cover all possible success and failure modes, starting from simple happy paths to long, complicated aggregate (including other resources) smoke tests.
6. Implement the Resource interfaces in `alchemy-effect/src/{cloud}/{service}/${resource}.ts`.

It is always worth reading through the established examples to understand the pattern:

- [Lambda Function](./alchemy-effect/src/aws/lambda/function.ts)
- [SQS Queue](./alchemy-effect/src/aws/sqs/queue.ts)
- [DynamoDB Table](./alchemy-effect/src/aws/dynamodb/table.ts)
- [VPC](./alchemy-effect/src/aws/ec2/vpc.ts)
- [Subnet](./alchemy-effect/src/aws/ec2/subnet.ts)

8. Implement the Resource Provider in `alchemy-effect/src/{cloud}/{service}/${resource}.provider.ts`.

It is always worth reading through the established examples to understand the pattern:

- [Lambda Function Provider](./alchemy-effect/src/aws/lambda/function.provider.ts)
- [SQS Queue Provider](./alchemy-effect/src/aws/sqs/queue.provider.ts)
- [DynamoDB Table Provider](./alchemy-effect/src/aws/dynamodb/table.provider.ts)
- [VPC Provider](./alchemy-effect/src/aws/ec2/vpc.provider.ts)
- [Subnet Provider](./alchemy-effect/src/aws/ec2/subnet.provider.ts)

7. Implement the Capabilities and Binding Providers in `alchemy-effect/src/{cloud}/{service}/${resource}.{capability}.ts`.

Read through the established capabilities before continuing so that you understand the pattern and structure of the capabilities and binding layers:

- [GetItem Binding Provider](./alchemy-effect/src/aws/dynamodb/table.get-item.ts)
- [SendMessage Binding Provider](./alchemy-effect/src/aws/sqs/queue.send-message.ts)
- [InvokeFunction Binding Provider](./alchemy-effect/src/aws/lambda/function.invoke.ts)

For Event Sources, see the [QueueEventSource Binding Provider](./alchemy-effect/src/aws/sqs/queue.event-source.ts) for an example which provides a comprehensive example of how to use pre-attach and attach properly for a Lambda Function event source.

9. Implement the test cases in `alchemy-effect/test/{cloud}/{service}/${resource}.test.ts`.

Read through the established test cases before continuing so that you understand the pattern and structure of the test cases.

- [GetItem Test Cases](./alchemy-effect/test/aws/dynamodb/table.provider.test.ts)
- [SendMessage Test Cases](./alchemy-effect/test/aws/sqs/queue.provider.test.ts)
- [InvokeFunction Test Cases](./alchemy-effect/test/aws/lambda/function.provider.test.ts)
- [VPC Test Cases](./alchemy-effect/test/aws/ec2/vpc.provider.test.ts)
- [Subnet Test Cases](./alchemy-effect/test/aws/ec2/subnet.provider.test.ts)

10. Consider implementing an aggregate Smoke test that brings together multiple resources that are often used together.

See the [VPC Smoke Test](./alchemy-effect/test/aws/ec2/vpc.smoke.test.ts) for an example.

10. Write the usage patterns for the Resource in `alchemy-effect/docs/{cloud}/{service}/${resource}.md`.
11. Write the index for the Service in `alchemy-effect/docs/{cloud}/{service}/index.md`.

# External References

We include various external references in the `.external` directory for you to search through using your tools.

## [Terraform AWS Provider Repository](.external/terraform-provider-aws)

- Docs for each Resource Provider are located in `.external/terraform-provider-aws/website/docs/r/`, e.g. `.external/terraform-provider-aws/website/docs/r/s3_bucket.html.markdown`.
- The source code for each Service is located in `.external/terraform-provider-aws/internal/service/{service}`, e.g. [s3](.external/terraform-provider-aws/internal/service/s3/).
- To list all available AWS services, you can simply `ls .external/terraform-provider-aws/internal/service/`.
- To list all available resources for a specific service, you can simply `ls .external/terraform-provider-aws/internal/service/{service}`.
- Each resource has a corresponding `{resource}.go` containing the Resource Provider implementation and `{resource}_test.go` file containing the test cases for the Resource Provider.

## [CloudFormation Documentation](.external/cfn)

- Docs for each Resource are located in `.external/cfn/{service}/{resource}.md`, e.g. `.external/cfn/s3/Bucket.md`.
- To list all available AWS services, you can simply `ls .external/cfn/`.
- To list all available resources for a service, you can simply `ls .external/cfn/{service}/`.
- To list all available resources for a specific service, you can simply `ls .external/cfn/{service}/`.
