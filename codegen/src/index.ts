import { Command, Options, Args } from "@effect/cli";
import * as Console from "effect/Console";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import packageJson from "../package.json";
import * as ConfigProvider from "effect/ConfigProvider";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Opencode, opencode, Session } from "./opencode.ts";
import { branch } from "./branch.ts";
import { designPath, sourcePath, testPath, lifecyclePaths } from "./paths.ts";
import { checkTypes } from "./check.ts";

const generateCommand = Command.make(
  "generate",
  {
    service: Args.text({ name: "service" }).pipe(
      Args.withDescription("Main file to generate"),
    ),
    resource: Options.text("resource").pipe(
      Options.withDefault(undefined),
      Options.withDescription("Resource to generate. Defaults to all."),
    ),
    clean: Options.boolean("clean").pipe(
      Options.withDefault(false),
      Options.withDescription("Clean up all previous sessions."),
    ),
  },
  ({ service, resource, clean }) =>
    Effect.gen(function* () {
      const { client } = yield* Opencode;

      const title = `generate-${service}${resource ? `-${resource}` : ""}`;

      const sessions = (yield* client.session.list()) ?? [];

      if (clean) {
        yield* Effect.all(
          sessions.map((session) => {
            return client.session.delete({ path: { id: session.id } });
          }),
        );
      }

      const prevSessions = ((yield* client.session.list()) ?? []).filter(
        (session) =>
          session.title.startsWith(
            `generate-${service}${resource ? `-${resource}` : ""}`,
          ),
      );
      const root = prevSessions.find(
        (session) => session.parentID === undefined && session.title === title,
      );
      if (root) {
        console.log(`Reusing existing session: ${root.id}`);
      }

      const rootSession =
        root ??
        (yield* client.session.create({
          body: {
            title,
          },
        }));

      if (!rootSession) {
        return yield* Effect.dieMessage(`Failed to create session: ${title}`);
      }

      yield* generateService(service).pipe(
        Effect.provide(Session.from(rootSession)),
      );
    }),
);

export const generateService = (service: string) =>
  Effect.gen(function* () {
    const { resources } = yield* generateIndex(service);

    // fan-out design of each resource and its lifecycle operations
    yield* Effect.all(
      resources.map((resource) =>
        Effect.gen(function* () {
          const design = yield* designResource(service, resource);
          const testCases = yield* designTestCases(service, resource);
          const [diff, read, preCreate, create, update, destroy] =
            yield* Effect.all([
              designLifecycle(service, resource, "Diff"),
              designLifecycle(service, resource, "Read"),
              designLifecycle(service, resource, "Pre-Create"),
              designLifecycle(service, resource, "Create"),
              designLifecycle(service, resource, "Update"),
              designLifecycle(service, resource, "Delete"),
            ]);
        }),
      ),
    );

    // implement the resource contracts in a single session so that contracts and identifier types can be circular and consistent
    yield* implementResourceContracts(service, resources);
  });

export const generateIndex = (service: string) =>
  branch(
    "index",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;

      const indexPath = yield* designPath(service, "index.md");
      const resourcesJson = yield* designPath(service, "resources.json");
      const loadFiles = Effect.gen(function* () {
        return {
          index: yield* fs.readFileString(indexPath),
          resources: (
            JSON.parse(yield* fs.readFileString(resourcesJson)) as {
              resources: string[];
            }
          ).resources,
        };
      });

      if ((yield* fs.exists(indexPath)) && (yield* fs.exists(resourcesJson))) {
        return yield* loadFiles;
      }
      yield* Console.log(`Designing index for ${service}`);
      yield* session.prompt(`Produce two documents ${indexPath} summarizing the service:
1. ${indexPath} is an overview of the resources in the service.

This document identifies each resource by name, provides a brief description of it and how it relates other resources in $1 or other services. 

Includes the following information:
- Resource Name
- Resource Description and Scope
- Resource Relationships (as a mermaid diagram)
- Noteworthy AWS APIs
- Noteworthy Errors
- Identifier Types

<tip>
Refer to the Terraform provider documentation and CloudFormation documentation in .external to help identify the resources and learn about their relationships.
</tip>

2. ${resourcesJson} is a JSON file that lists each resource by name.

Follow the following format:
\`\`\`json
{
  "resources": ["ResourceName1", "ResourceName2", "ResourceName3", ...]
}
\`\`\`
`);

      return yield* loadFiles;
    }),
  );

export const generateResource = (service: string, resource: string) =>
  branch(
    resource,
    Effect.gen(function* () {
      const design = yield* designResource(service, resource);
      const testCases = yield* designTestCases(service, resource);
      const [diff, read, preCreate, create, update, destroy] =
        yield* Effect.all([
          designLifecycle(service, resource, "Diff"),
          designLifecycle(service, resource, "Read"),
          designLifecycle(service, resource, "Pre-Create"),
          designLifecycle(service, resource, "Create"),
          designLifecycle(service, resource, "Update"),
          designLifecycle(service, resource, "Delete"),
        ]);

      yield* implementResourceProvider(service, resource);
      yield* implementResourceTestCases(service, resource);

      while (true) {
        yield* checkTypes(service, resource);
      }
    }),
  );

const designResource = (service: string, resource: string) =>
  branch(
    "design",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;
      const resourcePath = yield* designPath(service, `${resource}.md`);

      if (yield* fs.exists(resourcePath)) {
        return yield* fs.readFileString(resourcePath);
      }

      yield* Console.log(`Designing resource ${resource}`);

      yield* session.prompt(`Create a single document ${resourcePath} that describes the input and output properties of the resource and the procedure for each lifecycle method, including which APIs to call, which errors to retry, which errors are fatal. 

Include the following information (only):
- Input Properties
- Output Properties
- Error Handling (Error Tags, Retryable, Fatal)
- Retry Policy (Fixed Delay, Exponential Backoff, Max Retries, While Condition, Until Condition)
- Idempotency (Deterministic Physical Name Generation, Resource Tagging)

Do not include any code or code snippets. Natural language only in these design docs.

<tip>
Refer to the Terraform implementation in .external to source deep knowledge on which APIs to call, especially how to handle errors. It usually is captured by a function with a name like resource{Name}{Operation}() in the corresponding {name}.go file, so make sure to look for that file and analyze the code. Make sure to use the Error Tag names in AWS docs instead of HTTP status codes. E.g. BucketAlreadyExists is an error tag, not a HTTP status code. You can look up the API docs for AWS to source this information. 

If an input property or output attribute is deprecated in the terraform provider code, do not include it in our design document. It is with good reason that a property is deprecated and we should not support it. Don't bother documenting it, just ignore it.
</tip>

<warning>
Do not start writing the resource markdown file until you've read all relevant documentation and source code from Terraform and CloudFormation. 
</warning>
`);
    }),
  );

const designTestCases = (service: string, resource: string) =>
  branch(
    "test-cases",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;
      const indexPath = yield* designPath(service, "index.md");
      const resourcePath = yield* designPath(service, `${resource}.md`);
      const testPath = yield* designPath(service, `${resource}.test.md`);

      if (yield* fs.exists(testPath)) {
        return yield* fs.readFileString(testPath);
      }
      yield* Console.log(`Designing test cases for ${resource}`);
      yield* session.prompt(`Design the test cases for the resource and document them in ${testPath}.

Refer to ${resourcePath} to understand the current high-level design of the ${resource} resource.

If it's helpful, also check out the ${indexPath} to understand the high-level design of the ${service} service.

<tip>
This is where the Terraform source code comes in handy. Take a look at the relevant _test.go files and document each known test case. Keep test cases single purpose. 

After locating and reading the relevant _test.go files, enumerate the list of test cases functions in the file and then move on to writing the test case document in ${testPath}.
</tip>

Do not include any code or code snippets. Natural language only in these design docs.`);
      return yield* fs.readFileString(testPath);
    }),
  );

const designLifecycle = (
  service: string,
  resource: string,
  lifecycle: "Diff" | "Read" | "Pre-Create" | "Create" | "Update" | "Delete",
) =>
  branch(
    lifecycle,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;
      const resourcePath = yield* designPath(service, `${resource}.md`);
      const indexPath = yield* designPath(service, "index.md");
      const testPath = yield* designPath(service, `${resource}.test.md`);
      const lifecyclePath = yield* designPath(
        service,
        `${resource}.${lifecycle.toLowerCase()}.md`,
      );

      if (yield* fs.exists(lifecyclePath)) {
        return yield* fs.readFileString(lifecyclePath);
      }
      yield* Console.log(
        `Designing ${lifecycle} lifecycle operation for ${resource}`,
      );
      yield* session.prompt(`Create a single document ${lifecyclePath} that describes the ${lifecycle} lifecycle operation for the ${resource} resource.

Refer to the following helpful design documents:
- [${service} Service High-Level Design](${indexPath})
- [${resource} Resource High-Level Design](${resourcePath})
- [${resource} Test Cases](${testPath})

Use natural language to describe the if-this-then-that logic for the ${lifecycle} lifecycle operation. Use nested bullet point lists to structure the logic instead of long complex headings.

If an API call is made, identify each of the noteworthy errors that can be returned and how to handle them. Some errors may be expected and retryable, some may be fatal. If needed, research the AWS API docs to understand the errors. But better yet, go back and review the Terraform Provider Source Code to understand specifically which error codes are expected and handled. Use error codes (e.g. BucketAlreadyExists, BucketAlreadyOwnedByYou, etc.) instead of HTTP status codes when discussing errors.

Lifecycle operations are responsible for getting data or making modifications to cloud resources via APIs. They do not modify the IaC state directly and instead receive information about the current and desired state as input to their function. IaC state management is out of scope of this design document. Only the inputs, outputs and side-effects of the ${lifecycle} lifecycle operation are documented here.

Use mermaid diagrams. Do not roll your own ascii diagrams. 

Do not include any code or code snippets. Natural language only in these design docs.

<tip>
Take a look at the [ProviderService](./alchemy-effect/src/provider.ts) which contains the ${lifecycle} function definition that this design needes to inform the implementation of. But (remember) do not incude any code snippets in this document.
</tip>`);

      yield* Console.log(`Reviewing lifecycle '${lifecycle}' for ${resource}`);

      yield* session.prompt(
        `Please cross-reference the ${resourcePath} design document with the Terraform implementation in .external to ensure you have not missed any details. 
Go through the documented procedure step by step and make sure it aligns with what is in the terraform provider code. 
Make sure the document is written in a procedural style and does not include any code snippets (natural language only).
Look through terraform source code for this provider and lifecycle handler and make sure our documented procedure properly documents each error code (tag like BucketAlreadyExists, BucketAlreadyOwnedByYou, etc.) and how to handle them (retry, catch, fatal, etc.).`,
      );

      return yield* fs.readFileString(lifecyclePath);
    }),
  );

const implementResourceContracts = (service: string, resources: string[]) =>
  branch(
    "Contract",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;

      const resourceSources = yield* Effect.all(
        resources.map((resource) => sourcePath(service, `${resource}.ts`)),
      );
      const resourceDocs = (yield* Effect.all(
        resources.map((resource) =>
          Effect.gen(function* () {
            const spec = yield* designPath(service, `${resource}.md`);
            const [diff, read, preCreate, create, update, destroy] =
              yield* lifecyclePaths(service, resource);

            return `${resource}:
- [${resource} Resource Specification](${spec})
- [${resource} Diff Lifecycle Operation](${diff})
- [${resource} Read Lifecycle Operation](${read})
- [${resource} Pre-Create Lifecycle Operation](${preCreate})
- [${resource} Create Lifecycle Operation](${create})
- [${resource} Update Lifecycle Operation](${update})
- [${resource} Delete Lifecycle Operation](${destroy})`;
          }),
        ),
      )).join("\n\n");

      for (const resource of resources) {
        if (yield* fs.exists(yield* sourcePath(service, `${resource}.ts`))) {
          return;
        }
      }

      yield* Console.log(
        `Implementing resource contracts for ${resources.join(", ")}`,
      );

      yield* session.prompt(`Implement the resource contracts for the resources: ${resources.join(", ")}.

You should create the following files:
${resourceSources.map((spec) => `- ${spec}`).join("\n")}

Each file should include::
1. the Identifier Types introduced by that resource.

These are branded string types and constructor functions e.g. VpcId, SubnetId, TableArn, etc.). These should only be the identifier types explicitly owned by the corresponding resource. References to other resoruce identifier types should import those from the corresponding resource file

2. the Resource function
3. the Resource interface
4. the Props interface

Some properties in the Resource Interface will need to be wrapped with Input<T> if they can be references to other resources. E.g. the vpcId property in a Subnet is Input<VpcId> because it can be a lazy Output reference to the Vpc. Make sure to think about which properties of \${Resource}Props should be Inputs. Common ones are identifiers references to other resources and tags.

5. the \${Resource}Attrs<Props extends Input.Resolve<\${Resource}Props>> interface

The \${Resource}Attrs interface represents the output attributes of the resource. It accepts the resolved input properties of \${Resource}Props as input at the type-level and uses them to compute the output attributes of the resource. That way, the \${Resource}Attrs interface can use knowledge of what the properties are to inform the type-system of what the output attributes are at the type-level. E.g. whether something is undefined because a flag was known to be false.

The Props are resolved with Input.Resolve to transform any Input<T> properties to T. Attrs can never be Inputs, only ever literal primitive or object values.

<tip>
Read the following examples to understand the pattern:
- [VPC](./alchemy-effect/src/aws/ec2/vpc.ts)
- [Subnet](./alchemy-effect/src/aws/ec2/subnet.ts)
- [Table](./alchemy-effect/src/aws/dynamodb/table.ts)
- [Queue](./alchemy-effect/src/aws/sqs/queue.ts)
</tip>

<warning>
Do not put comments like this in the file:
\`\`\`typescript
// ============================================================================
// Input Properties
// ============================================================================
\`\`\`

We don't need any separators.
</warning>

<warning>
Do not include anything except:
1. the Identifier Types
2. the Resource function
3. the Resource interface
4. the Props interface
5. the \${Resource}Attrs<Props extends Input.Resolve<\${Resource}Props>> interface

Everything else is outside of scope.
</warning>

<requirements>
Before getting started, please read the following documentation:
${resourceDocs}
</requirements>

Use the documentation to write and document the types. Each input property's documentation should include information on how it affects the resource lifecycle (e.g. causes replacement, or can be updated, etc.)

Procuce only the following files:
${resourceSources.map((spec) => `- ${spec}`).join("\n")}
`);
    }),
  );

const implementResourceProvider = (service: string, resource: string) =>
  branch(
    "Provider",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;
      const resourceSpec = yield* designPath(service, `${resource}.md`);
      const resourceSrc = yield* sourcePath(service, `${resource}.ts`);
      const providerSrc = yield* sourcePath(service, `${resource}.provider.ts`);
      const [diff, read, preCreate, create, update, destroy] =
        yield* lifecyclePaths(service, resource);

      if (yield* fs.exists(providerSrc)) {
        return yield* fs.readFileString(providerSrc);
      }

      yield* Console.log(`Implementing resource provider for ${resource}`);

      yield* session.prompt(`Implement the resource provider for the ${resource} resource.

This file implemenets the [ProviderService](./alchemy-effect/src/provider.ts) as a Layer for the ${resource} resource.

<warning>
Do not put comments like this in the file:
\`\`\`typescript
// ============================================================================
// Input Properties
// ============================================================================
\`\`\`

We don't need any separators.
</warning>

<tip>
<Make sure

- [Lambda Function Provider](./alchemy-effect/src/aws/lambda/function.provider.ts)
- [SQS Queue Provider](./alchemy-effect/src/aws/sqs/queue.provider.ts)
- [DynamoDB Table Provider](./alchemy-effect/src/aws/dynamodb/table.provider.ts)
- [EC2 VPC Provider](./alchemy-effect/src/aws/ec2/vpc.provider.ts)
- [EC2 Subnet Provider](./alchemy-effect/src/aws/ec2/subnet.provider.ts)
- [SQS Queue Provider](./alchemy-effect/src/aws/sqs/queue.provider.ts)
</tip>

<requirements>
Before getting started, please read the following requirement specifications:
- [${resource} Resource Contract Design](${resourceSpec}) which contains documentation on the required Input Properties and Output Attributes.
- [${resource} Diff Lifecycle Operation](${diff}) which contains documentation on the Diff lifecycle operation for the ${resource} resource.
- [${resource} Read Lifecycle Operation](${read}) which contains documentation on the Read lifecycle operation for the ${resource} resource.
- [${resource} Pre-Create Lifecycle Operation](${preCreate}) which contains documentation on the Pre-Create lifecycle operation for the ${resource} resource.
- [${resource} Create Lifecycle Operation](${create}) which contains documentation on the Create lifecycle operation for the ${resource} resource.
- [${resource} Update Lifecycle Operation](${update}) which contains documentation on the Update lifecycle operation for the ${resource} resource.
- [${resource} Delete Lifecycle Operation](${destroy}) which contains documentation on the Delete lifecycle operation for the ${resource} resource.
- [${resource} Contract Implementation](${resourceSrc}) which contains the ${resource} Resource, ${resource}Props, ${resource}Attrs and Identifier Types.
</requirements>

Then, implement the provider for the ${resource} resource according to the aforementioned requirement specifications.

Produce a single file: ${providerSrc}
`);
    }),
  );

const implementResourceTestCases = (service: string, resource: string) =>
  branch(
    "Tests",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* Session;

      const testFile = yield* testPath(service, `${resource}.test.ts`);
      const testCases = yield* designPath(service, `${resource}.test.md`);
      const providerSrc = yield* sourcePath(service, `${resource}.provider.ts`);
      const resourceSrc = yield* sourcePath(service, `${resource}.ts`);
      const [diff, read, preCreate, create, update, destroy] =
        yield* lifecyclePaths(service, resource);

      // if (yield* fs.exists(testFile)) {
      //   return yield* fs.readFileString(testFile);
      // }

      yield* Console.log(`Implementing resource test cases for ${resource}`);

      yield* session.prompt(`Implement the resource test cases for the ${resource} resource.

Refer to the following documentation to understand the test cases:
- [${resource} Test Cases](${testCases})
- [${resource} Provider Implementation](${providerSrc})
- [${resource} Contract Implementation](${resourceSrc})
- [${resource} Diff Lifecycle Operation](${diff}) which contains documentation on the Diff lifecycle operation for the ${resource} resource.
- [${resource} Read Lifecycle Operation](${read}) which contains documentation on the Read lifecycle operation for the ${resource} resource.
- [${resource} Pre-Create Lifecycle Operation](${preCreate}) which contains documentation on the Pre-Create lifecycle operation for the ${resource} resource.
- [${resource} Create Lifecycle Operation](${create}) which contains documentation on the Create lifecycle operation for the ${resource} resource.
- [${resource} Update Lifecycle Operation](${update}) which contains documentation on the Update lifecycle operation for the ${resource} resource.
- [${resource} Delete Lifecycle Operation](${destroy}) which contains documentation on the Delete lifecycle operation for the ${resource} resource.

Use the documentation to write and document the test cases. Each test case should include information on the expected input and output properties, the expected errors, and the expected retry policy.

Workflow:
1. Read the current version of ${testFile} if it exists and run the test cases to ensure they pass. If they don't work on the existing tests before moving on to the next step.
2. Create a TODO list with one item for each remaining test case. Start with simple tests and work your way forward.
3. After writing a test, you should then run that specific test to ensure it passes.This avoids getting overwhelmed with failing tests and allows you to focus on getting the basic foundation working. If you need to make changes to the ${providerSrc}, make sure you run all tests to ensure there are no regressions.

<test_command>
\`bun run test ./\${resource}.test.ts -t "{testCaseName}"\`
</test_command>

Produce a single file: ${testFile}
`);

      return yield* fs.readFileString(testFile);
    }),
  );

const root = Command.make("codegen", {}).pipe(
  Command.withSubcommands([generateCommand]),
);

// Set up the CLI application
const cli = Command.run(root, {
  name: "Alchemy Effect CLI",
  version: packageJson.version,
});

// Prepare and run the CLI application
cli(process.argv).pipe(
  // $USER and $STAGE are set by the environment
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.provide(NodeContext.layer),
  Effect.provide(opencode),
  NodeRuntime.runMain,
);
