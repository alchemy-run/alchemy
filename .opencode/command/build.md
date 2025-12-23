---
description: Build a new AWS Service's Infrastructure-as-Code Resources
---

I want you to design and build the resources for AWS $1. This involves the following steps:

:::warning
You must design and implement all resources in the service. Do not be lazy by focusing on a subset of resources.
:::

:::warning
Never dispatch catch-all/bundled tasks to sub-agents like "Design remaining resource test cases". Always dispatch specific, single-purpose tasks like "Design resource test cases for Bucket".
:::

:::tip
Any step that is a "for each" step, e.g. for each resource, the task should be performed in parallel by dispatching a sub-agent and not one-by-one. Once you get rolling, each resource should largely be independent of each other.
:::

1. Start with producing a document alchemy-effect/design/aws/$1/index.md that is an overview of the resources in the service.

This document identifies each resource by name, provides a brief description of it and how it relates other resources in $1 or other services.

Includes the following information:

- Resource Name
- Resource Description and Scope
- Resource Relationships (as a mermaid diagram)
- Noteworthy AWS APIs
- Noteworthy Errors
- Identifier Types

:::tip
Refer to the Terraform provider documentation and CloudFormation documentation in .external to help identify the resources and learn about their relationships.
:::

2. Then, for each identified resource, create a document alchemy-effect/design/aws/$1/{resource}.md that describes the input and output properties of the resource and the procedure for each lifecycle method, including which APIs to call, which errors to retry, which errors are fatal.

Include the following information:

- Input Properties
- Output Properties
- Lifecycle Operations (Diff, Read, Pre-Create, Create, Update, Delete)
- Error Handling (Error Tags, Retryable, Fatal)
- Retry Policy (Fixed Delay, Exponential Backoff, Max Retries, While Condition, Until Condition)
- Idempotency (Deterministic Physical Name Generation, Resource Tagging)

Do not include any code or code snippets. Natural language only in these design docs.

:::tip
Refer to the Terraform implementation in .external to source deep knowledge on which APIs to call, especially how to handle errors. It usually is captured by the function func resource{Name}{Operation}() in the corresponding {name}.go file, so make sure to look for that file and analyze the code. Make sure to use the Error Tag names in AWS docs instead of HTTP status codes. E.g. BucketAlreadyExists is an error tag, not a HTTP status code. You can look up the API docs for AWS to source this information.
:::

:::warning
Do not start writing the resource markdown file until you've read all relevant documentation and source code from Terraform and CloudFormation.
:::

3. For each identified resource, design the test cases for the resource in alchemy-effect/design/aws/$1/{resource}.test.md.

:::tip
This is where the Terraform source code comes in handy. Take a look at the relevant \_test.go files and document each known test case. Keep test cases single purpose.
:::

Do not include any code or code snippets. Natural language only in these design docs.

4. Now that we've documented each of the test cases, provide a detailed write-up of each resource's lifecycle handler logic.

Work on each lifecycle operation as isolated tasks per resource (do not bundle them into a single task):
a. Diff alchemy-effect/design/aws/$1/{resource}.diff.md.
b. Read alchemy-effect/design/aws/$1/{resource}.read.md.
c. Pre-Create alchemy-effect/design/aws/$1/{resource}.pre-create.md.
d. Create alchemy-effect/design/aws/$1/{resource}.create.md.
e. Update alchemy-effect/design/aws/$1/{resource}.update.md.
f. Delete alchemy-effect/design/aws/$1/{resource}.delete.md.

Be detailed and focused on error handling (in terms of error tags), retry policies, idempotency and eventual consistency.

:::tip
Make sure to refer to always analyze what the Terraform implementation in .external does for the corresponding lifecycle operation (except for pre-create, which does not exist in terraform).
:::

Do not include any code or code snippets. Natural language only in these design docs.

5. After writing each lifecycle operation, review the .md file and cross-reference it again with the corresponding terraform implementation in .external to ensure you have not missed any details.

6. For each identified resource, implement the Service's identifier types in alchemy-effect/src/aws/$1/id.types.ts.

Include only identifier types that are used by the resource. Do not include resource definitions, props or attributes. E.g it should include VpcId, SubnetId, etc. but not Vpc, VpcProps, Subnet, SubnetProps, etc.

7. For each identified resource, implement the resource's interface (Resource, Props and Attributes) in alchemy-effect/src/aws/$1/{resource}.ts.

8. For each identified resource, implement the resource's provider in alchemy-effect/src/aws/$1/{resource}.provider.ts.

:::tip
Make sure to read through the established provider examples to understand the overall pattern and structure of a provider. They all follow the same pattern and often follow the same pattern for error handling.
:::

9. For each identified resource, implement the resource's test cases in alchemy-effect/test/aws/$1/{resource}.test.ts.

:::tip
Make sure to read through the established test cases to understand the overall pattern and structure of a test case. They all follow the same pattern and often follow the same pattern for error handling.
:::
