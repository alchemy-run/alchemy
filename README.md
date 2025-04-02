# Alchemy

Alchemy is an embeddable, zero-dependency, TypeScript-native Infrastructure-as-Code (IaC) library for modeling Resources that are Created, Updated and Deleted automatically.

Unlike similar tools like Pulumi, Terraform, and CloudFormation, Alchemy is implemented in pure ESM-native TypeScript code with zero dependencies.

Resources are simple memoized async functions that can run in any JavaScript runtime, including the browser, serverless functions and durable workflows.

```ts
import alchemy from "alchemy";

await using app = alchemy("cloudflare-worker");

export const worker = await Worker("worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
  bindings: {
    COUNTER: counter,
    STORAGE: storage, // Bind the R2 bucket to the worker
    AUTH_STORE: authStore,
    GITHUB_CLIENT_ID: secret(process.env.GITHUB_CLIENT_ID),
    GITHUB_CLIENT_SECRET: secret(process.env.GITHUB_CLIENT_SECRET),
  },
});
```

# Features

- **JS-native** - no second language, toolchains, dependencies, processes, services, etc. to lug around.
- **Async-native** - resources are just async functions - no complex abstraction to learn.
- **ESM-native** - built exclusively on ESM, with a slight preference for modern JS runtimes like Bun.
- **Embeddable** - runs in any JavaScript/TypeScript environment, including the browser!
- **Extensible** - implement your own resources with a simple function.
- **AI-first** - alchemy actively encourages you to use LLMs to create/copy/fork/modify resources to fit your needs. No more waiting around for a provider to be implemented, just do it yourself in a few minutes.
- **No dependencies** - the `alchemy` core package has 0 required dependencies.
- **No service** - state files are stored locally in your project and can be easily inspected, modified, checked into your repo, etc.
- **No strong opinions** - structure your codebase however you want, store state anywhere - we don't care!

# Examples

- CloudFlare ViteJS Website + API Backend with Durable Objects: [examples/cloudflare-vite/](./examples/cloudflare-vite/alchemy.run.ts)
- Deploy an AWS Lambda Function with a DynamoDB Table and IAM Role: [examples/aws-app/](./examples/aws-app/alchemy.run.ts)

# Getting Started

An alchemy "app" (if you want to call it that) is just an ordinary TypeScript or JavaScript script. Once you've installed the `alchemy` package, you can start using it however you want.

```bash
# I recommend bun, but you can use any JavaScript runtime.
bun add alchemy
```

Usually, you'll want to create an `alchemy.config.ts` script and then define your Resources.

> [!TIP]
> The `alchemy.config.ts` file is just a convention, not a requirement.

Your script should start by creating the Alchemy `app` (aka. "Root Scope", more on [Scopes](#resource-scope-tree) later):

```ts
import alchemy from "alchemy";

// async disposables trigger finalization of the stack at the end of the script (after resources are declared)
await using app = alchemy("my-app", {
  // namespace for stages
  stage: process.env.STAGE ?? "dev",
  // update or destroy the app
  phase: process.argv.includes("--destroy") ? "destroy" : "up"
  // password for encrypting/decrypting secrets stored in state
  password: process.env.SECRET_PASSPHRASE,
  // whether to log Create/Update/Delete events
  quiet: process.argv.includes("--verbose") ? false : true,
});

// (otherwise, declare resources here AFTER the bootstrap)
```

Now that our app is initialized, we can start creating Resources, e.g. an AWS IAM Role:

```ts
import { Role } from "alchemy/aws";

export const role = await Role("my-role", {
  roleName: "my-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        // Or whatever principal you want
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});
```

Notice how the `Role` is created by an `await Role(..)` function call.
In contrast to other IaC frameworks, Alchemy models Resources as memoized async functions that can be executed in any async environment - including the browser, serverless functions and durable workflows.

A nice benefit of async-await is how easy it becomes to access physical properties (otherwise known as "Stack Outputs").
You can just log the role name (crazy concept, right?):

```ts
console.log({
  roleName: role.roleName, // string
});
```

## Alchemy State

Now, when you run your script:

```sh
bun ./my-app.ts
```

You'll notice some files show up in `.alchemy/`:

```sh
.alchemy/
  my-app/
    prod/
      my-role.json
```

These are called the "state files".

Go ahead, click on one and take a look - here's how my `my-role.json` looks:

```jsonc
{
  "provider": "iam::Role",
  "data": {},
  "deps": [],
  "status": "updated",
  "output": {
    "roleName": "alchemy-api-lambda-role"
    // ..
  },
  "props": {
    "roleName": "alchemy-api-lambda-role",
    "assumeRolePolicy": {
      "Version": "2012-10-17"
      // ..
    }
  }
}
```

Alchemy uses state to determine when to Create, Update, Delete or Skip Resources at runtime:

1. If the resource doesn't have a prior state, it will be `created`
1. If the inputs haven't changed since the last deployment, then it will be `skipped`,
1. If the inputs have changed, it will be `updated`
1. If the Resource no longer exists in the program (aka. is an orphan), then it will be `deleted`.

> [!TIP]
> Alchemy goes to great effort to be fully transparent. Each Resource's state is just a JSON file, nothing more. You can inspect it, modify it, commit it to your repo, store it in a database, etc.

## "Custom" Resources

Adding new Resources is the whole point of Alchemy, and is therefore very simple.

A Resource provider is just a function with a globally unique name, e.g. `dynamo::Table`, and an implementation of the Create, Update, Delete lifecycle operations.

Below is an illustrative example of the `dynamo::Table` provider.

> [!NOTE]
> See [table.ts](./alchemy/src/aws/table.ts) for the full implementation.

All Resources follow the same templated structure/convention:

1. an interface (or type) for the Resource's (Input) Properties

```ts
// a type to represent the Resource's input properties
export interface TableProps {
  name: string;
  //..
}
```

2. an interface (or type) for the Resource's (Output) Attributes

```ts
// declare a type to represent the Resource's properties (aka. attributes)
export interface Table extends Resource<"dynamo::Table"> {
  tableArn: string;
}
```

3. a special "Resource" function defining the Resource's globally unique name and resource lifecycle handler:

```ts
export const Table = Resource(
  "dynamo::Table",
  async function (
    // the resource context (phase, previous state, etc.) is made available as the bound `this` param
    this: Context<TableOutput>,
    // the resource's ID (unique within the current Scope)
    id: string,
    // the resource input properties
    props: TableInputs
  ): Promise<Table> {
    // this function implement the CRUD resource lifecycle for an instance of this Resource

    if (this.phase === "create") {
      // (create logic)
    } else if (this.phase === "update") {
      // (update logic)
    } else if (this.phase === "delete") {
      // (delete logic)

      // terminate the delete process early
      return this.destroy();
    }
    // return the created/updated resource properties
    return this(props);
  }
);
```

<details>
  <summary>Nitty gritty details on this pattern's design and oddities</summary>
I call this pattern the "pseudo class", designed to model a Resource with a CRUD lifecycle implemented with memoized async functions.

The `this` parameter in this "pseudo class" serves many purposes:

1. contains the resource' `phase` (`create`, `update`, `delete`)
2. contains the resource's current state and previous props (`this.props`, `this.fqn`, `this.stage`, `this.scope`)
3. provides a handle to destroy the resource (`this.destroy`)
4. provides a factory for constructing the resource object (`this({..}`) - you can think of this as emulating `super({..})`
</details>

> [!TIP]
> Use Cursor or an LLM like Claude/OpenAI to generate the implementation of your resource. I think you'll be pleasantly surprised at how well it works, especially if you provide the API reference docs in your context.

That's it! Now you can instantiate DynamoDB Tables:

```ts
const table = await Table("items", {
  name: "items",
  //..
});

table.tableArn; // string
```

## Secrets

Recall that the `alchemy` function accepts a `password` property:

```ts
await using app = alchemy("my-app", {
  // password for encrypting/decrypting secrets stored in state
  password: process.env.SECRET_PASSPHRASE,
});
```

This password is used to encrypt and decrypt secret data within an Alchemy state:

```ts
const OPENAI_API_KEY = alchemy.secret(process.env.OPENAI_API_KEY);
```

Now, I can pass this secret to a Resource safely:

```ts
await Worker("my-func", {
  bindings: {
    OPENAI_API_KEY,
  },
});
```

In our `.alchemy/` state, the property will be encrypted instead of plain text:

```json
{
  "props": {
    "bindings": {
      "OPENAI_API_KEY": {
        "@secret": "Tgz3e/WAscu4U1oanm5S4YXH..."
      }
    }
  }
}
```

## Resource Scope Tree

Alchemy manages resources with a named tree of `Scope`s, similar to a file system. Each Scope has a name and contains named Resources and other (named) Scopes.

### Application Scope

The `alchemy` bootstrap (in your `alchemy.config.ts`) creates and binds to the Alchemy Application Scope (aka. "Root Scope"):

```ts
await using app = alchemy("my-app", {
  stage: "prod",
  // ..
});
```

To get a better understanding, notice how it has 1:1 correspondence with the `.alchemy/` state files:

```sh
.alchemy/
  my-app/ # app scope
    prod/ # stage scope
      my-role.json # resource instance
```

### Stage Scope

When you create an app, you can also specify a `stage`.

Stage is just an opinionated Scope placed under the root useful as a convention for isolating "stages" such as `prod`, `dev`, `$USER`.

```ts
await using app = alchemy("my-app", {
  // scope: my-app/prod
  stage: "prod",
});
```

### Instance Scope

Each Resource instance has its own scope to isolate Resources created in its Lifecycle Handler:

```ts
export const MyResource = Resource(
  "my::Resource",
  async function (this, id, props) {
    if (this.phase === "delete") {
      return this.destroy();
    }
    await Role("my-role");
    await Worker("my-worker");
  }
);
```

When you create an instance of `MyResource`, its nested Resources will be scoped to the Resource Instance:

```ts
await MyResource("instance");
```

```sh
.alchemy/
  my-app/ # app
    prod/ # stage
      instance.json    # instance
      instance/        # instance scope
        my-role.json   # instance
        my-worker.json # instance
```

### Nested Scopes

Nested Scopes are stored within their parent Scope's state folder:

```sh
.alchemy/
  my-app/ # app
    prod/ # stage
      nested/ # scope
        my-worker.json # instance
```

> [!TIP]
> Scopes can be nested arbitrarily.

### `alchemy.scope`

You can create and "enter" a Nested Scope synchronously in a function. This will create and set the current async context's Scope (using AsyncLocalStorage):

```ts
await using scope = alchemy.scope("nested");

// resources created AFTER are placed in the "nested' Scope
await Worker("my-worker");
```

### `alchemy.run`

You can also create nested scopes using the `alchemy.run` function and a closure:

```ts
await alchemy.run("nested", async () => {
  // resources created in here are isolated to the "nested' Scope
  await Worker("my-worker");
});

// resources out here are placed in the "parent" SCope
await Worker("my-worker");
```

### Get the current Scope

The current Scope is stored in `AsyncLocalStorage` and accessible when needed:

```ts
Scope.current; // will throw if not in a scope
Scope.get(); // Scope | undefined
await alchemy.run("nested", async (scope) => {
  // scope is passed in as an argument
});
// create a Scope and bind to the current async context
using scope = alchemy.scope("nested");
```

## `destroy`

`Scope`, `Resource` and `ResourcePromise` can be "destroyed" individually and programmatically.

### Destroy a Resource

Say, you've got some two resources, a `Role` and a `Function`.

```ts
const role = await Role("my-role", {
  name: "my-role",
  //..
});

const func = await Function("my-function", {
  name: "my-function",
  role: role.roleArn,
  //..
});
```

Each of these Resources is known as a "sub-graph".

In this case we have `Role` (a 1-node graph, `Role`), and `Function` (a 2-node graph, `Role → Function`).

Each sub-graph can be "applied" or "destroyed" individually using the `apply` and `destroy` functions:

```ts
import { destroy } from "alchemy";

await destroy(func); // will delete just the Function

// destroy deletes the resource and any downstream dependencies
// so, if you want to delete Role AND Function, you should call destroy(role)
await destroy(role); // will delete Role and then Function
```

### Destroy a Scope

You can destroy all Resources in a Scope with a single `destroy` call:

```ts
const scope = alchemy.scope("scope");
try {
  await Role("role");
  await Worker("worker");
} finally {
  // destroy them all!
  await destroy(scope);
}
```

### Destroy the App

To destroy the whole app (aka. the whole graph), you can call `alchemy` with the `phase: "destroy"` option. This will delete all resources in the specified or default stage.

```ts
await using _ = alchemy({
  phase: "destroy",
  // ..
});
```

> [!TIP]
> Alchemy is designed to have the minimum number of opinions as possible. This "embeddable" design is so that you can implement your own tools around Alchemy, e.g. a CLI or UI, instead of being stuck with a specific tool.
>
> ```ts
> await using _ = alchemy({
>   // decide the mode/stage however you want, e.g. a CLI parser
>   phase: process.argv[2] === "destroy" ? "destroy" : "up",
>   stage: process.argv[3],
> });
> ```

## Test Resources

> [!NOTE]
> TODO

## Physical Names

> [!CAUTION]
> It is up to you to ensure that the physical names of resources don't conflict - alchemy does not (yet) offer any help or opinions here. You must decide on physical names, but you're free to add name generation logic to your resources if you so desire.
>
> ```ts
> const Table = Resource("dynamo::Table", async function (this, inputs) {
>   const tableName = `${this.stage}-${inputs.tableName}`;
>
>   // ..
> });
> ```
