# Workflow

The Workflow resource lets you create [Cloudflare Workers Workflow](https://developers.cloudflare.com/workers/configuration/workflows/) instances that can be bound to Workers.

# Minimal Example

Create a basic workflow that can be bound to a Worker:

```ts
import { Workflow } from "alchemy/cloudflare";

const workflow = await Workflow("my-workflow", {
  workflowName: "my-workflow",
  className: "MyWorkflow"
});
```

# Bind to a Worker

Bind the workflow to a Worker to enable workflow functionality:

```ts
import { Worker, Workflow } from "alchemy/cloudflare";

const workflow = await Workflow("my-workflow", {
  workflowName: "my-workflow", 
  className: "MyWorkflow"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    MY_WORKFLOW: workflow
  }
});
```