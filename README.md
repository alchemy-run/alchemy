# Alchemy

Alchemy is a embeddable, zero-dependency, TypeScript-native Infrastructure-as-Code (IaC) library that provides the minimal pieces for modeling Resources that are Created, Updated and Deleted automatically.

Unlike similar tools like Pulumi, Terraform, and CloudFormation, Alchemy is implemented in pure ESM-native TypeScript code with zero dependencies. Resources are simple memoized async functions that can run in any JavaScript runtime, including the browser, serverless and durable workflows.

[![Demo](./alchemy.gif)](./alchemy.gif)

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

- CloudFlare ViteJS Website + API Backend with Durable Objects: [examples/cloudflare-vite/](./examples/cloudflare-vite/)
- Deploy an AWS Lambda Function with a DynamoDB Table and IAM Role: [examples/aws-app/](./examples/aws-app/)

# Getting Started

An alchemy "app" (if you want to call it that) is just an ordinary TypeScript or JavaScript script. Once you've installed the `alchemy` package, you can start using it however you want.

```bash
# I recommend bun, but you can use any JavaScript runtime.
bun add alchemy
```

Usually, you'll want to create an `alchemy.config.ts` script where you'll define your initial resources.
`alchemy.config.ts` is just a convention, not a requirement.

Your Alchemy script should start with the following "bootstrap":

```ts
import alchemy from "alchemy";

// async disposables trigger finalization of the stack at the end of the script (after resources are declared)
await using app = alchemy("my-app", {
  // namespace for
  stage: process.env.STAGE ?? "dev",
  // password for encrypting/decrypting secrets stored in state
  password: process.env.SECRET_PASSPHRASE,
  // whether to log Create/Update/Delete events
  quiet: process.argv.includes("--verbose") ? false : true,
});

if (process.argv.includes("--destroy")) {
  // destroy the stack and exit early (return `never`)
  await alchemy.destroy(app);
}

// (otherwise, declare resources here AFTER the bootstrap)
```

> [!NOTE]
> Alchemy makes use of Async Disposables (the `await using _` syntax) to execute finalization logic at the end of your script.
>
> See the [ECMAScript Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) RFC to learn more about Async Disposables.

Now that our app is initialized, we can start creating Resources. For example, an AWS IAM Role:

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
In contrast to other IaC frameworks, Alchemy models Resources as memoized async functions.
They can be executed in any async environment, including the browser, serverless functions or durable workflows.

A nice benefit of async-await is how easy it becomes to access physical properties (otherwise known as "Stack Outputs").
E.g. you can just log the role name:

```ts
console.log({
  roleName: role.roleName, // string
});
```

Now, when you run your script:

```sh
bun ./my-app.ts
```

You'll notice some files show up in `.alchemy/`:

```
.alchemy/
  - my-app/
    - prod/
      - my-role.json
```

These are called the State files. Go ahead, click on one and take a look. Here's how my `my-role.json` looks:

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
  "inputs": [
    {
      "roleName": "alchemy-api-lambda-role",
      "assumeRolePolicy": {
        "Version": "2012-10-17"
        // ..
      }
    }
  ]
}
```

> [!TIP]
> Alchemy goes to great effort to be fully transparent. Each Resource's state is just a JSON file, nothing more. You can inspect it, modify it, commit it to your repo, store it in a database, etc.

## Resource "Scopes"

Alchemy manages resources with a named tree of `Scope`s, similar to a file system tree. Each Scope has a name and contains named Resources and other (named) nested Scopes.

The `alchemy` call from before (in your `alchemy.config.ts`) actually initiated the Alchemy Application Scope (aka. "Root Scope"):

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

### `alchemy.run`

You can create nested scopes using the `alchemy.run` function. This will call your closure

```ts
await alchemy.run("nested", async () => {
  await Worker("my-worker");
});
```

Nested scopes are stored within their parent Scope's state folder:

```sh
.alchemy/
  my-app/ # app
    prod/ # stage
      nested/ # scope
        my-worker.json # instance
```

> [!TIP]
> Scopes can be nested arbitrarily.

### Get the current Scope

The current Scope is stored in `AsyncLocalStorage` and accessible by many means:

```ts
Scope.current; // will throw if not in a scope
Scope.get(); // Scope | undefined
await alchemy.run("nested", async (scope) => {
  // scope is passed in as an argument
});
// create a Scope and bind to the current async context
using scope = alchemy.scope("nested");
```

### Resource instances are Scopes

Each Resource instance also has its own scope to isolated Resources created in its Lifecycle Handler:

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

When I create an instance of `MyResource`, its nested resources will be scoped to the instance:

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

## Creating a Resource Provider

Adding new resources is the whole point of Alchemy, and is therefore very simple.

A Resource provider is just a function with a globally unique name, e.g. `dynamo::Table`, and an implementation of the Create, Update, Delete lifecycle operations.

E.g. below we show what a simple `dynamo::Table` provider might look like.

> [!NOTE]
> See [table.ts](./alchemy/src/aws/table.ts) for the full implementation.

```ts
// a type to represent the Resource's inputs
export interface TableInputs {
  name: string;
  //..
}

// declare a type to represent the Resource's properties (aka. attributes)
export interface Table extends Resource<"dynamo::Table"> {
  tableArn: string;
}

export const Table = Resource(
  "dynamo::Table",
  async function (
    this: Context<TableOutput>,
    id: string,
    inputs: TableInputs
  ): Promise<Table> {
    if (this.phase === "create") {
      // create logic
    } else if (this.phase === "update") {
      // update logic
    } else if (this.phase === "delete") {
      // delete logic
      return this.destroy();
    }
    // return the created/updated resource properties
    return this(output);
  }
);
```

> [!TIP]
> Use Cursor or an LLM like Claude/OpenAI to generate the implementation of your resource. I think you'll be pleasantly surprised at how well it works, especially if you provide the API reference docs in your context.

That's it! Now you can instantiate tables in your app.

```ts
const table = await Table("items", {
  name: "items",
  //..
});

table.tableArn; // string
```

## `apply` and `destroy`

Any object in your graph (`Resource` or `Promise<Resource>`) can be "applied" or "destroyed" individually and programmatically.

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
import { apply, destroy } from "alchemy";

// will create Role and then Function (in that order)
const { functionArn } = await apply(func);

// you can destroy it right after if you want ☠️
await destroy(func); // will delete just the Function

// destroy deletes the resource and any downstream dependencies
// so, if you want to delete Role AND Function, you should call destroy(role)
await destroy(role); // will delete Role and then Function
```

## Destroying the app

To destroy the whole app (aka. the whole graph), you can call `alchemy` with the `mode: "destroy"` option. This will delete all resources in the specified or default stage.

```ts
await using _ = alchemy({
  mode: "destroy",
  // ..
});
```

> [!TIP]
> Alchemy is designed to have the minimum number of opinions as possible. This "embeddable" design is so that you can implement your own tools around Alchemy, e.g. a CLI or UI, instead of being stuck with a specific tool.
>
> ```ts
> await using _ = alchemy({
>   // decide the mode/stage however you want, e.g. a CLI parser
>   mode: process.argv[2] === "destroy" ? "destroy" : "up",
>   stage: process.argv[3],
> });
> ```

## "Stage" and State

> [!NOTE]
> Stage is inspired by [SST](https://sst.dev)'s stage concept.

Alchemy supports a "stage" concept to help isolate different environments from each other. E.g. a `"user"` or `"dev"` or `"prod"` stage.

By default, the stage is assumed to be your user name (a sensible default for local development).

To override the stage, you have three options:

1. Pass the `stage` option to `alchemize`/`apply`/`destroy` (recommended)

```ts
// alchemize the entire app
await alchemize({ stage: "production" });

// apply a single resource
await apply(func, { stage: "production" });
```

2. Config in `./alchemy.ts` (up to you if you want to have a global config). See the [alchemy.ts section](#global-values-and-the-alchemy-ts-config-file) for more details.

```ts
export default {
  defaultStage: "production",
};
```

3. Set the `ALCHEMY_STAGE` environment variable (not recommended, but available as an escape hatch)

```sh
ALCHEMY_STAGE=production bun ./my-app.ts
```

Each Resource "provider" can access the stage it's being deployed to via the `ctx.stage` property.

```ts
class Table extends Resource("dynamo::Table", async (ctx, inputs) => {
  ctx.stage; // "production"
});
```

> [!CAUTION]
> It is up to you to ensure that the physical names of resources don't conflict - alchemy does not (yet) offer any help or opinions here. You must decide on physical names, but you're free to add name generation logic to your resources if you so desire.
>
> ```ts
> class Table extends Resource("dynamo::Table", async (ctx, inputs) => {
>   const tableName = `${ctx.stage}-${inputs.tableName}`;
>
>   // ..
> });
> ```

## Global values and the `alchemy.ts` config file.

Alchemy looks for a `${cwd}/alchemy.ts` file and imports it if it finds it. This can be useful for emulating SST's `sst.config.ts` file as a convention for global configuration.

It supports overriding the `defaultStage` (instead of defaulting to your username) and providing a custom `stateStore` (instead of writing to the local file system).

```ts
import type { Config } from "alchemy";

export default {
  defaultStage: "dev",
  stateStore: myCustomStateStore,
} satisfies Config;
```

> [!NOTE]
> See [global.ts](./alchemy/src/global.ts).
