# Alchemy

Alchemy is a JS-native, embeddable library for the materialization of resource graphs. From Infrastructure-as-Code (IaC) to code generation, Alchemy provides the fundamental building blocks for modeling resources that are Created, Updated and Deleted automatically.

Unlike similar tools like Pulumi, Terraform, and CloudFormation, Alchemy is implemented in pure ESM-native TypeScript with zero dependencies. It can run in any JavaScript runtime, including the browser.

[![Demo](./alchemy.gif)](./alchemy.gif)

# Features

- **JS-native** - no second language, toolchains, dependencies, processes, services, etc. to lug around.
- **ESM-native** - built exclusively on ESM, with a slight preference for modern JS runtimes like Bun.
- **Embeddable** - runs in any JavaScript/TypeScript environment, including the browser!
- **Extensible** - implement your own resources with a simple function.
- **AI-first** - alchemy actively encourages you to use LLMs to create/copy/fork/modify resources to fit your needs. No more waiting around for a provider to be implemented, just do it yourself in a few minutes.
- **No dependencies** - the `alchemy` core package has 0 required dependencies.
- **No service** - state files are stored locally in your project and can be easily inspected, modified, checked into your repo, etc.
- **No strong opinions** - structure your codebase however you want, store state anywhere - we don't care!

# Examples

- LLM-based code generation of all 200+ AWS CloudFormation resources: [examples/generate-aws-cfn/gen.ts](./examples/generate-aws-cfn/gen.ts)
- Deploy an AWS Lambda Function with a DynamoDB Table and IAM Role: [examples/deploy-aws/app.ts](./examples/deploy-aws/)
- Generate a TODO application from a Markdown document: [examples/markdown-program/index.md](./examples/markdown-program/)

# Getting Started

An alchemy "app" (if you want to call it that) is just an ordinary TypeScript or JavaScript script. Once you've installed the `alchemy` package, you can start using it however you want.

```bash
# I recommend bun, but you can use any JavaScript runtime.
bun add alchemy
```

Usually, you'll want to create a script where you'll define your resources.

```ts
import { Role } from "alchemy/aws";

const role = new Role("my-role", {
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

Then, call `alchemize` at the end to trigger the Create/Update/Delete lifecycle.

```ts
await alchemize();
```

Finally, run your script.

```sh
bun ./my-app.ts
```

You'll notice some files show up in your repo:

```
.alchemy/
  - sam/
    - my-role.json
```

Go ahead, click on one and take a look. Here's how my role looks:

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
> Alchemy goes to great effort to be fully transparent. State is just a JSON file, nothing more. You can inspect it, modify it, commit it to your repo, etc.

## `alchemize`

Calling `alchemize` will create new resources, update modified resources and then delete "orphaned" resources at the end.

This is equivalent to `terraform apply`, `pulumi up`, `cdk deploy`, etc. except really fast and in your control.

## Creating a Resource Provider

Adding new resources is the whole point of Alchemy, and is therefore very simple.

A Resource provider is just a function with a globally unique name, e.g. `dynamo::Table`, and an implementation of the Create, Update, Delete lifecycle operations.

E.g. below we show what a simple `dynamo::Table` provider might look like.

> [!NOTE]
> See [table.ts](./alchemy/src/components/aws/table.ts) for the full implementation.

```ts
interface TableInputs {
  name: string;
  //..
}
interface TableOutput {
  tableArn: string;
}
class Table extends Resource(
  "dynamo::Table",
  async (ctx: Context<TableOutput>, inputs: TableInputs) => {
    if (ctx.event === "create") {
      // create logic
    } else if (ctx.event === "update") {
      // update logic
    } else if (ctx.event === "delete") {
      // delete logic
    }
    // ..
    return output;
  }
) {}
```

> [!TIP]
> Use Cursor or an LLM like Claude/OpenAI to generate the implementation of your resource. I think you'll be pleasantly surprised at how well it works, especially if you provide the API reference docs in your context.

That's it! Now you can instantiate tables in your app.

```ts
const table = new Table("items", {
  name: "items",
  //..
});

table.tableArn; // Output<string>
```

You may have noticed the odd pattern of extending the result of a function call, `extends Resource(..)`. This is called the "mix-in" pattern and is optional. You are free to just use a `const` instead:

```ts
const Table = Resource("dynamo::Table", async (ctx, inputs) => {
  //..
});

const table = new Table("items", {
  name: "items",
  //..
});
```

> [!TIP]
> I recommend using a class so each resource has a type, e.g. `Table`, and a place to add helper/utility methods. Totally optional, though. Knock yourself out.

## Lazy Outputs

A Resource is evaluated lazily (not when you call `new`), so you can't immediately access the value of a property like `tableArn` or `functionArn`. Instead you reference properties using the `Output<T>` interface.

```ts
const table = new Table("my-table", { .. });

const tableArn = table.tableArn; // Output<string>
```

Outputs can be chained explicitly and implicitly:

1. _Explicitly_ with `.apply`

```ts
const tableArn: Output<string> = table.tableArn.apply((arn: string) =>
  // do something with the arn string value
  arn.replace("table", "arn:aws:dynamodb:")
);
```

2. _Implicitly_ chained

```ts
const tableArn = table.attributeDefinitions[0].attributeName; // Output<string>
// equivalent to:
// table.apply(t => t.attributeDefinitions[0].attributeName);
```

> [!NOTE]
> Output is inspired by Pulumi, with a little extra added sugar.

## `apply` and `destroy`

Calling `alchemize` is optional. Any object in your graph (`Resource` or `Output<T>`) can be "applied" or "destroyed" individually and programmatically.

Say, you've got some two resources, a `Role` and a `Function`.

```ts
const role = new Role("my-role", {
  name: "my-role",
  //..
});

const func = new Function("my-function", {
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

To destroy the whole app (aka. the whole graph), you can call `alchemize` with the `mode: "destroy"` option. This will delete all resources in the specified or default stage.

```ts
await alchemize({ mode: "destroy", stage: <optional> });
```

> [!TIP]
> Alchemy is designed to have the minimum number of opinions as possible. This "embeddable" design is so that you can implement your own tools around Alchemy, e.g. a CLI or UI, instead of being stuck with a specific tool.
>
> ```ts
> await alchemize({
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
