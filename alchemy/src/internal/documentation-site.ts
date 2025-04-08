import path from "node:path";
import { Document } from "../ai/";
import { alchemy } from "../alchemy";
import { StaticSite } from "../cloudflare";
import { CopyFile, Folder } from "../fs";
import { HomePage, VitePressConfig, VitepressProject } from "../web/vitepress";
import { GettingStarted } from "./getting-started";
import { AlchemyProviderDocs } from "./providers";
import { TutorialGroup } from "./tutorials";

export async function DocumentationSite() {
  const vitepress = await VitepressProject("vitepress", {
    name: "alchemy-web",
    delete: true,
  });

  const docsPublic = await Folder("docs-public", {
    path: path.join(vitepress.dir, "public"),
  });

  const blogs = await Folder("blogs", {
    path: path.join(vitepress.dir, "blogs"),
  });

  await CopyFile("docs-public-alchemist", {
    src: path.join(process.cwd(), "public", "alchemist.webp"),
    dest: path.join(docsPublic.path, "alchemist.webp"),
  });

  await HomePage("docs-home", {
    outFile: path.join(vitepress.dir, "index.md"),
    title: "Alchemy",
    hero: {
      name: "Alchemy",
      text: "Create Update Delete",
      tagline:
        "Agentic Infrastructure-as-Code workflows in pure async TypeScript that runs anywhere",
      // "A minimal, embeddable, JS-native Infrastructure-as-Code library optimized for Gen-AI",
      // "Building the Assembly Line for self-generated software and services",
      image: {
        src: "/alchemist.webp",
        alt: "The Alchemist",
      },
      actions: [
        {
          text: "Get Started",
          link: "/docs/getting-started",
          theme: "brand",
        },
      ],
    },
  });

  const docs = await Folder("docs", {
    path: path.join(vitepress.dir, "docs"),
  });

  const providers = await Folder("providers", {
    path: path.join(docs.path, "providers"),
  });

  const filterIdx = process.argv.findIndex((arg) => arg === "--filter");

  const providersDocs = await AlchemyProviderDocs({
    srcDir: path.join("alchemy", "src"),
    outDir: providers.path,
    // anthropic throttles are painful, so we'll run them serially
    parallel: false,
    filter:
      process.argv[filterIdx + 1] === "true"
        ? true
        : filterIdx > -1
          ? isNaN(parseInt(process.argv[filterIdx + 1]))
            ? false
            : parseInt(process.argv[filterIdx + 1])
          : false,
  });

  const conceptsDir = await Folder("concepts", {
    path: path.join(docs.path, "concepts"),
  });

  const concepts: Document[] = [];
  // do in series to avoid rate limiting
  for (const [concept, prompt] of Object.entries({
    Resource: await alchemy`
        # Resource

        (1-2 sentences of what it is)

        # How to create a Resource

        await Worker("my-worker", {
          // ...
        })

        # How to update a Resource

        await Worker("my-worker", {
          // (updated properties)
        })

        # What is a Resource Provider

        interface MyResourceProps { }
        interface MyResource extends Resource<"my::resource"> { }

        const MyResource = Resource(
            "my::resource", 
            async function(this: Context<MyResource>, props: MyResourceProps) {
                if (this.phase === "delete") {
                    return this.destroy();
                } else if (this.phase === "create") {
                    // create
                } else if (this.phase === "update") {
                    // update
                }
                return this({});
            }
        );

        # The CRUD lifecycle

        (when resources are created, updated and deleted)

        # State

        Briefly introduce the concept of

        (NOTE: link to /docs/concepts/state for more information)

        # Resource Scope

        (1 sentence on how each Resource has its own Scope)

        (NOTE: link to /docs/concepts/scope for more information on Scopes)

        (show a simple resource provider that awaits other Resources within)

    `,
    Scope: await alchemy`
        # Scope

        (briefly describe the concept of a Scope, Scope hierarchy, and how it is used to manage the lifecycle of Resources)

        # The Application Scope

        // Create the root application scope
        const app = await alchemy("my-app");

        # Scope Finalization 

        // Finalize the scope to ensure all resources are created
        await scope.finalize();

        # The Stage Scope

        (introduce how when you create an Application, a child Stage scope is created by default)
        const dev = await alchemy("my-app", {
          stage: "dev" // Defaults to $USER if not specified
        });

        # Nested Scopes

        (explain how you can create nested scopes to isolate resources)
        await alchemy.run("nested-scope", async (scope) => {
          // Resources created here are part of the nested scope
        });

        # Resource Scopes

        (explain how each Resource has its own Scope that manages its lifecycle and dependencies)

        # Destroying Scopes

        await alchemy.destroy(scope);

        # Resource Scopes

        Each Resource has its own Scope that manages its lifecycle and dependencies.

        # Orphaned Resources

        After scope finalization, Alchemy detects any resources that are no longer referenced by any scope and marks them for cleanup.

        # Scope State

        (explain how state is stored in the .alchemy folder in your project and link to /docs/concepts/state for more information)
    `,
    State: await alchemy`
        # State Management in Alchemy

        Explain how Alchemy uses a state management system to track resources and their dependencies across scopes.

        # The State Store Interface

        Describe how the state store interface is designed to be storage-agnostic, supporting:
        - Local filesystem (.alchemy folder)
        - Cloud storage (S3, R2)
        - Databases (DynamoDB, SQLite)
        - Other key-value stores


        # Default State Storage

        Show how state is stored by default in the .alchemy folder:

        \`\`\`
        (annotated file system structure of the .alchemy folder)
        \`\`\`

        # State File Format

        Show an example state file:

        \`\`\`json
        (example)
        \`\`\`

        # Override the Application State Store

        (explain how the state store is pluggable and how to override the application state store)

        import { R2RestStateStore } from "alchemy/cloudflare";

        const app = alchemy("my-app", {
          state: new R2RestStateStore({
            bucket: "my-bucket",
            accessKeyId: "my-access-key-id",
            secretAccessKey: "my-secret-access-key",
          })
        });

        # Override a Scope's Application State Store

        (explain how you can also configure a different state store for a specific scope)

        await alchemy.run("my-app", {
          stateStore: new R2StateStore({
            bucket: "my-bucket",
            accessKeyId: "my-access-key-id",
            secretAccessKey: "my-secret-access-key",
          })
        }, async (scope) => {
            // ...
        })

        > [!NOTE]
        > Nested scopes inherit the state store of their parent scope (unless otherwise specified)
    `,
    Bindings: await alchemy`
        # Bindings

        Bindings allow you to connect resources together in a type-safe way. They are commonly used to connect resources like KV Namespaces and R2 Buckets to Cloudflare Workers.

        ## Binding Resources to Workers

        (explain how Cloudflare resources can be bound to Workers)

        \`\`\`typescript
        const bucket = await R2Bucket("my-bucket", {
          name: "my-bucket"
        });

        const worker = await Worker("api", {
          // ... other worker config
          bindings: {
            MY_BUCKET: bucket
          }
        });
        \`\`\`

        ## Type-Safe Bindings

        (explain how to get type-safe access to bindings in your Worker code)

        1. Create an env.d.ts file:

        ${alchemy.file("./examples/cloudflare-vite/src/env.d.ts")}

        (make sure to explain how the /// reference pragma is required to make the types available globally)

        2. Import the env type in your Worker:

        \`\`\`typescript
        import { env } from "cloudflare:workers";

        export default {
          async fetch(request: Request, env: env) {
            // now we can access the bindings safely
            const file = await env.MY_BUCKET.get("image.jpg");
          }
        };
        \`\`\`

        > [!NOTE]
        > The /// <reference types="@cloudflare/workers-types" /> pragma is required to make the types available globally
    `,
    Secrets: await alchemy`
        # Secrets in Alchemy

        (explain what secrets are and why they're important for sensitive data)

        # Creating Encrypted Secrets

        (show how to use alchemy.secret() with examples)

        # How Secrets are Encrypted

        (show how the Secret is serialized and stored in @state)

        # Application Scope Password

        (explain how to set password when initializing app scope)

        \`\`\`typescript
        (code example showing alchemy() initialization with password)
        \`\`\`

        # Scope-Level Passwords

        (explain how to use different passwords for individual scopes)

        \`\`\`typescript
        (code example showing alchemy.run() with scope password)
        \`\`\`

        # Binding Secrets to Workers

        (explain how to bind secrets to Cloudflare Workers)

        1. Bind the Secret to the Worker
        \`\`\`typescript
        (code example showing secret binding to worker)
        \`\`\`

        2. Access the Secret in your Worker
        \`\`\`typescript
        (code example showing secret access at runtime in a cloduflare worker)
        \`\`\`

        (link to /docs/concepts/bindings for more information on bindings)

        > [!NOTE]
        > (important note about secret handling)

        > [!TIP]
        > (helpful tip about secret management)
    `,
    Testing: await alchemy`
        # Testing in Alchemy

        (explain how alchemy resources can be tested by using alchemy.test() to simplify scope management)

        # Setting up Tests

        (show example of importing test utilities and setting up a test file)
        
        # Test Scope

        (explain how import.meta is used to create a scope for the test suite and per test)
        (show example corresponding .alchemy/ folder structure)

        # Writing Test Cases

        (show a simple test case structure, test("..."), try { create resource, update resource, finally destroy(scope)})

        # Test Configuration

        (explain test configuration options, destroy, quiet, etc.)

        # Resource Lifecycle Testing

        (show how to test resource creation, update, and deletion)

        # Working with Test Scopes

        (explain how test scopes isolate resources)

        # Cleanup and Error Handling

        (explain best practices for cleanup and error handling)
    `,
  })) {
    const doc = await Document(concept, {
      path: path.join(conceptsDir.path, `${concept.toLowerCase()}.md`),
      title: concept,
      model: {
        provider: "anthropic",
        id: "claude-3-7-sonnet-latest",
        options: {
          // anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
        },
      },
      prompt: await alchemy`
        Write an introduction to the ${concept} concept in Alchemy.
        Focus purely on the ${concept} concept and its relationship to the other concepts.
        Each step should use a heading and follow a natural progression of the concept.
        Maximum 1-2 sentences per point being made.
        Use NOTE and TIP blocks to provide additional information without cluttering the main content.
        > [!NOTE]
        > This is a note

        > [!TIP]
        > This is a tip

        Project Template/Structure:
        ${prompt}

        Refer to ${alchemy.file("./README.md")} for more information on Alchemy. 
        Refer to ${alchemy.file("./.cursorrules")} for Alchemy's own rules that automate 90% of the development of Alchemy resources.
        Refer to ${alchemy.file("./alchemy/src/serde.ts")} for how state is serialized and stored.
        Refer to ${alchemy.file("./alchemy/src/scope.ts")} for the implementation details of the Scope Resource.
        Refer to ${alchemy.file("./alchemy/src/resource.ts")} for the implementation details of the Resource Resource.
        Refer to ${alchemy.file("./alchemy/src/state.ts")} for the implementation details of the State Resource.
        Refer to ${alchemy.file("./alchemy/src/fs/file-system-state-store.ts")} for the implementation details of the FileSystem State Store.
        Refer to ${alchemy.file("./alchemy/src/secret.ts")} for the implementation details of the Secrets Resource.
        Refer to ${alchemy.file("./alchemy/src/cloudflare/worker.ts")}
        Refer to ${alchemy.file("./alchemy/src/cloudflare/kv-namespace.ts")}
        Refer to ${alchemy.file("./alchemy/src/cloudflare/bucket.ts")}
        Refer to ${alchemy.file("./examples/cloudflare-vite/src/env.d.ts")} for an example of how to infer the binding types by import type { apiWorker }
        Refer to ${alchemy.file("./examples/cloudflare-vite/alchemy.run.ts")} for an example of how to deploy a Cloudflare Worker and Static Site using Alchemy.
        Refer to ${alchemy.file("./alchemy/src/test/bun.ts")} to understand how the test utility works with import.meta.
    `,
    });
    concepts.push(doc);
  }

  const whatIsAlchemy = await Document("what-is-alchemy", {
    path: path.join(docs.path, "what-is-alchemy.md"),
    title: "What is Alchemy?",
    model: {
      provider: "anthropic",
      id: "claude-3-7-sonnet-latest",
      options: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 12000 },
        },
      },
    },
    temperature: 0.2,
    prompt: await alchemy`
        # Overview
        (brief overview of Alchemy as a lightweight TypeScript IaC library)

        # Pure TypeScript Functions
        (explain how Alchemy uses pure async TypeScript vs other IaC tools)

        const worker = await Worker("api", {
          path: "./src/worker.ts",
          bindings: {
            MY_BUCKET: bucket
          }
        });

        # All resourcs are Custom Resources
        (explain how all resources in Alchemy are "custom" and creating your own is trivial)

        (show a content-less skeleton of what a Custom Resource looks like)
        interface MyResourceProps
        interface MyResource extends Resource<"my:Resource">
        const MyResource = Resouce("my:Resource",
          async function(this: MyResource, id: string, props: MyResourceProps) {
            // ...
          }
        );

        Link to /docs/tutorials/writing-custom-resource

        # AI-Optimized Resources
        (explain how resources are optimized for LLM generation)
        (link to https://github.com/sam-goodwin/alchemy/blob/main/.cursorrules)
        (link to /docs/tutorials/writing-custom-resource)

        # Project Structure
        (explain alchemy.run.ts as main entry point)

        (code block showing .alchemy/ folder structure)

        # State Management
        (explain .alchemy folder, pluggable state, resource lifecycle)

        (code block of state file)

        # Resource Scoping
        (explain how scopes isolate resources)

        await alchemy.run("dev", async (scope) => {
          const bucket = await R2Bucket("assets", {
            name: "my-dev-bucket"
          });
        });

        # Resource Lifecycle
        (explain recursive resources and automatic cleanup)

        # Scope Management
        (explain alchemy.run() and scope creation)

        # Resource Cleanup
        (explain alchemy.destroy() for scope cleanup)

        # Secrets Management
        (explain alchemy.secret() and encryption)

        const app = alchemy("my-app", {
          password: process.env.ALCHEMY_PASSWORD
        });

        # Testing Resources
        (explain alchemy.test with example)

        const test = alchemy.test(import.meta);

        test("create and update worker", async (scope) => {
          const worker = await Worker("api", {
            path: "./src/worker.ts"
          });
        });

        link to /docs/concepts/testing

        Refer to the ${alchemy.file("./README.md")} for more information on what Alchemy is.
        Refer to ${alchemy.file("./.cursorrules")} for deep information on how to build custom resources with Alchemy.
        Refer to ${alchemy.file("./examples/cloudflare-vite/alchemy.run.ts")} for an example of how to deploy a Cloudflare Worker and Static Site using Alchemy.
        Refer to ${alchemy.file("./examples/aws-app/alchemy.run.ts")} for an example of how to deploy an AWS Lambda Function using Alchemy.
        Refer to ${alchemy.file("./examples/cloudflare-vite/alchemy.run.ts")} for an example of how to deploy a Cloudflare Worker and Static Site using Alchemy.

        Alchemy Concept Documentation:
        ${concepts}
    `,
  });

  let tutorialGroup: TutorialGroup | undefined;
  if (process.argv.includes("--tutorials")) {
    // Create tutorials directory
    const tutorials = await Folder("tutorials", {
      path: path.join(docs.path, "tutorials"),
    });

    // Create a tutorial group with common system prompt to ensure consistent structure
    tutorialGroup = await TutorialGroup("alchemy-tutorials", {
      systemPrompt: await alchemy`
        Follow these guidelines for all tutorials:
        Always start with a link to /docs/getting-started to get set up and a link to a relevant Cloud Provider (e.g. AWS, Cloudflare, Anthropic, OpenAI, etc).
        Do not bother explaining how to install alchemy, bun or any other tool.
        Simply start with "create ./alchemy.run.ts" and then each step adds (at most) one resource.
        Use a consistent step-by-step approach with clear headings
        Include code examples with proper syntax highlighting
        Explain each step thoroughly but concisely
        Use the same structure for prerequisites and setup sections
        Always use bun as the package manager and to run scripts
        End with next steps and additional resources
        Subsequent steps in a tutorial that update a previously written file should include only the new content (and do not repeat the previously written content)

        Include code examples and explanations for each step.
        Never use more than one Resource in a code snippet example.
        Keep each step as short, simple and concise as possible - do not over explain.
        Only introduce one thing at a time - avoid large, long code blocks. One code block = one concept, one statement.

        Context on What is Alchemy: ${whatIsAlchemy}
        Context on Concepts: ${concepts}
        README: ${alchemy.file("./README.md")}
        `,
      difficulty: "beginner",
      estimatedTime: 5,
      model: {
        provider: "anthropic",
        id: "claude-3-7-sonnet-latest",
        // options: {
        //   anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
        // },
      },
      tutorials: [
        {
          title: "Deploying a Cloudflare Worker and Static Site",
          path: path.join(
            tutorials.path,
            "deploy-cloudflare-worker-and-static-site.md"
          ),
          prompt: await alchemy`
            # Overview
            
            (brief overview of deploying a Cloudflare Worker and Static Site with Alchemy)
            
            # Prerequisites
            
            (link to /docs/getting-started to set up a project)
            
            # Setting Up a Vite Project
            
            (explain how to initialize a vite project with bun create vite my-alchemy-app --template react-ts)
            
            # Creating a Static Site Resource
            
            (show how to create a StaticSite and configure it to build and deploy the vite project)
            
            # Deploying the Static Site
            
            (show console.log({ url: staticSite.url }) and how to run \`bun ./alchemy.run\`)
            (explain the output with an example snippet)
            
            # Creating an API
            
            (explain how to create src/api.ts with a hono app that serves data from env.DB.get())
            
            # Adding a KV Namespace
            
            (show how to create a KV Namespace for data storage)
            
            # Creating a Worker with Bindings
            
            (show how to create a Worker and bind the KV namespace)
            
            # Type-Safe Bindings
            
            (explain how to use env.d.ts and infer binding types with import type { apiWorker })
            
            # Connecting the Frontend to the API
            
            (show how to update App.tsx to fetch data from the API)
            
            # Deploying the Complete Application
            
            (explain how to run \`bun ./alchemy.run\` again)
            (show the output of the worker and static site)
            
            Reference these files for implementation details:
            - ${alchemy.file("./alchemy/src/cloudflare/worker.ts")} 
            - ${alchemy.file("./alchemy/src/cloudflare/static-site.ts")} 
            - ${alchemy.file("./alchemy/test/cloudflare/worker.test.ts")} 
            - ${alchemy.file("./alchemy/test/cloudflare/static-site.test.ts")} 
            - ${alchemy.file("./alchemy/src/cloudflare/kv-namespace.ts")} 
            - ${alchemy.file("./alchemy/test/cloudflare/kv-namespace.test.ts")}
            - ${alchemy.file("./examples/cloudflare-vite/src/env.d.ts")}
    
            See ${alchemy.file("./examples/cloudflare-vite/alchemy.run.ts")} to understand how alchemy.run.ts is used to deploy the worker and static site.
            `,
        },
        {
          title: "Bundling and Deploying an AWS Lambda Function",
          path: path.join(tutorials.path, "deploy-aws-lambda-function.md"),
          prompt: await alchemy`
            # Overview
            
            (brief overview of deploying an AWS Lambda Function with Alchemy)
            
            # Prerequisites
            
            (link to /docs/getting-started and AWS setup requirements)
            
            # Initializing the Alchemy Application
            
            (show how to initialize alchemy() with a stage and mode)
            
            # Creating a Lambda Function
            
            (show how to create a minimal AWS Lambda Function script that uploads a file to S3)
            
            # Setting Up an S3 Bucket
            
            (explain how to create the S3 Bucket resource)
            
            # Creating an IAM Role
            
            (show how to create an IAM Role with read/write access to the S3 bucket)
            
            # Bundling the Function
            
            (explain how to use the Bundle resource to package the Lambda function)
            
            # Deploying the Lambda
            
            (show how to create the Lambda Function using the Bundle)
            
            # Running the Deployment
            
            (explain how to deploy the stack using bun ./alchemy.run.ts)
            
            # Testing the Lambda
            
            (show how to invoke the Lambda Function from the CLI)
            
            # Understanding the State
            
            (illustrate the .alchemy/ state folder structure and contents)
            
            # Cleaning Up Resources
            
            (explain how to tear everything down with bun ./alchemy.run.ts --destroy)

            Reference these files for implementation details:
            - ${alchemy.file("./alchemy/src/esbuild/bundle.ts")} - For Bundle implementation
            - ${alchemy.file("./alchemy/test/esbuild.test.ts")} - For Bundle test implementation
            - ${alchemy.file("./alchemy/src/aws/function.ts")} - For Lambda implementation
            - ${alchemy.file("./alchemy/test/aws/function.test.ts")} - For Lambda test implementation
            - ${alchemy.file("./alchemy/src/aws/bucket.ts")} - For S3 Bucket implementation
            - ${alchemy.file("./alchemy/src/aws/role.ts")} - For IAM role implementation
            - ${alchemy.file("./alchemy/test/aws/function.test.ts")} - For testing examples
            - ${alchemy.file("./examples/aws-app/alchemy.run.ts")} - to understand how alchemy.run.ts is used to deploy the lambda function.
            `,
        },
        {
          title: "Create a Custom Resource with AI",
          path: path.join(tutorials.path, "writing-custom-resource.md"),
          prompt: await alchemy`
            # Overview
            
            (brief overview of creating custom Alchemy resources with AI assistance)
            
            # Prerequisites
            
            (link to /docs/getting-started and requirements)
            
            # Understanding the Resource Pattern
            
            (explain the basic structure of Alchemy resources)
            
            # Using Cursor Rules
            
            (explain the .cursorrules file and how it helps AI generate resources)
            
            # Creating a New Resource
            
            (walk through the process of creating a new resource)
            
            # Example: Neon Database Resource
            
            (present the example prompt for a Neon Database resource)
            
            > Build me a Resource for Neon Database
            > Refer to their API: https://api-docs.neon.tech/reference/createprojectbranchdatabase
            > Create the resource, accept the API key as a Secret
            > Then, write and run the tests to ensure it works.
            
            # Implementing the Resource
            
            (explain how to implement the resource following patterns)
            
            # Writing Tests
            
            (show how to write and run tests for the custom resource)
            
            # Best Practices
            
            (provide best practices for custom resource creation)

            Reference these files for implementation patterns:
            - ${alchemy.file("./alchemy/src/stripe/price.ts")}
            - ${alchemy.file("./alchemy/test/stripe.test.ts")}
            - ${alchemy.file("./alchemy/src/cloudflare/worker.ts")}
            - ${alchemy.file("./alchemy/test/cloudflare/worker.test.ts")}
            
            See the docs on the Alchemy Concepts:
            ${concepts}
            `,
        },
      ],
    });
  }

  await GettingStarted({
    path: path.join(docs.path, "getting-started.md"),
    prompt: await alchemy`
        # Installation
        
        (explain how to install with bun add alchemy and mention that there's nothing special about alchemy.run.ts - it's just a script that can run anywhere)
        
        # Your First Alchemy Application
        
        (show a minimal alchemy.run.ts example)
        
        # Creating Your First Resource
        
        (demonstrate how to create a simple File Resource)
        
        # Running the Application
        
        (explain how to run the application with bun ./alchemy.run.ts)
        (describe how it would have created a file)
        
        # Understanding State
        
        (introduce the .alchemy/ folder structure and explain the state file format)
        
        # Resource Lifecycle
        
        (show how to remove the resource and run again)
        (explain how the file is now gone along with its state file)
        
        # Next Steps
        
        (list of next steps to explore)
        1. Jump to [examples](https://github.com/sam-goodwin/alchemy/tree/main/examples).
        ${tutorialGroup?.tutorials.map((t, i) => `${i + 1}. [${t.title}](/docs/tutorials/${path.basename(typeof t.path === "string" ? t.path : t.path.path, ".md")})`).join("\n")}

        See ${alchemy.file("./README.md")} to understand the overview of Alchemy.
        See ${alchemy.file("./.cursorrules")} to better understand the structure and conventions of Alchemy.
        See ${alchemy.file("./examples/cloudflare-vite/alchemy.run.ts")} to better understand the structure and conventions of Alchemy.
        See ${alchemy.file("./examples/aws-app/alchemy.run.ts")} to better understand the structure and conventions of Alchemy.
        See ${alchemy.file("./alchemy/test/cloudflare/worker.test.ts")} for an example of how testing works.

        Alchemy Concept Documentation:
        ${concepts}
    `,
  });

  await VitePressConfig({
    cwd: vitepress.dir,
    title: "Alchemy",
    description: "Alchemy Docs",
    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Docs", link: "/docs/getting-started" },
        { text: "Blogs", link: "/blogs/" },
      ],
      sidebar: [
        {
          text: "Get Started",
          link: "/docs/getting-started",
        },
        {
          text: "What is Alchemy?",
          link: "/docs/what-is-alchemy",
        },
        {
          text: "Concepts",
          link: "/docs/concepts",
          collapsed: false,
          items: concepts.map((c) => ({
            text: c.title,
            link: `/docs/concepts/${path.basename(c.path!)}`,
          })),
        },
        {
          text: "Tutorials",
          collapsed: true,
          items: tutorialGroup?.tutorials.map((t) => ({
            text: t.title,
            link: `/docs/tutorials/${path.basename(typeof t.path === "string" ? t.path : t.path.path)}`,
          })),
        },
        {
          text: "Providers",
          link: "/docs/providers",
          collapsed: false,
          items: providersDocs
            .sort((a, b) => a.provider.localeCompare(b.provider))
            .map((p) => ({
              text: p.provider,
              collapsed: true,
              items: p.documents
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((r) => ({
                  text: r.title,
                  link: `/docs/providers/${p.provider}/${path.basename(r.path!)}`,
                })),
            })),
        },
      ],
    },
  });

  if (process.argv.includes("--publish")) {
    const site = await StaticSite("alchemy.run site", {
      name: "alchemy",
      dir: path.join(vitepress.dir, ".vitepress", "dist"),
      domain: "alchemy.run",
      build: {
        command: "bun run --filter=alchemy-web docs:build",
      },
    });

    console.log("Site URL:", site.url);
  }
}
