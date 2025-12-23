import { Command, Options, Args } from "@effect/cli";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import packageJson from "../package.json";
import * as ConfigProvider from "effect/ConfigProvider";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Opencode, opencode, Session } from "./opencode.ts";
import { branch } from "./branch.ts";

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
    for (const resource of resources) {
      if (resource === "Bucket") {
        console.log(`Generating ${resource}`);
        yield* generateResource(service, resource);
      } else {
        console.log(`Skipping ${resource} as it is not supported yet`);
      }
    }
  });

const designPath = (service: string, doc: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join("alchemy-effect", "design", "aws", service, doc);
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

:::tip
Refer to the Terraform provider documentation and CloudFormation documentation in .external to help identify the resources and learn about their relationships.
:::

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

      yield* session.prompt(`Create a single document ${resourcePath} that describes the input and output properties of the resource and the procedure for each lifecycle method, including which APIs to call, which errors to retry, which errors are fatal. 

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
      yield* session.prompt(`Design the test cases for the resource and document them in ${testPath}.

Refer to ${resourcePath} to understand the current high-level design of the ${resource} resource.

If it's helpful, also check out the ${indexPath} to understand the high-level design of the ${service} service.

:::tip
This is where the Terraform source code comes in handy. Take a look at the relevant _test.go files and document each known test case. Keep test cases single purpose. 
:::

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
      yield* session.prompt(`Create a single document ${lifecyclePath} that describes the ${lifecycle} lifecycle operation for the ${resource} resource.

Refer to the following helpful design documents:
- [${service} Service High-Level Design](${indexPath})
- [${resource} Resource High-Level Design](${resourcePath})
- [${resource} Test Cases](${testPath})

Use natural language to describe the if-this-then-that logic for the ${lifecycle} lifecycle operation.

If an API call is made, identify each of the noteworthy errors that can be returned and how to handle them. Some errors may be expected and retryable, some may be fatal. If needed, research the AWS API docs to understand the errors. But better yet, go back and review the Terraform Provider Source Code to understand specifically which error codes are expected and handled. Use error codes (e.g. BucketAlreadyExists, BucketAlreadyOwnedByYou, etc.) instead of HTTP status codes when discussing errors.

Lifecycle operations are responsible for getting data or making modifications to cloud resources via APIs. They do not modify the IaC state directly and instead receive information about the current and desired state as input to their function. IaC state management is out of scope of this design document. Only the inputs, outputs and side-effects of the ${lifecycle} lifecycle operation are documented here.

Use mermaid diagrams. Do not roll your own ascii diagrams. 

Do not include any code or code snippets. Natural language only in these design docs.`);
      return yield* fs.readFileString(lifecyclePath);
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
