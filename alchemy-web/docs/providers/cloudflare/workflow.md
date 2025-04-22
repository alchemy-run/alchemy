# Workflow

A [Cloudflare Workflow](https://developers.cloudflare.com/workers/configuration/workflows/) allows you to define reusable sequences of Workers that can be composed together.

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

Bind the workflow to a Worker to enable workflow execution:

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

# Workflow with Custom Parameters

Create a workflow with typed parameters that can be passed when executing:

```ts
import { Workflow } from "alchemy/cloudflare";

interface MyWorkflowParams {
  userId: string;
  action: "create" | "update" | "delete";
}

const workflow = await Workflow<MyWorkflowParams>("my-workflow", {
  workflowName: "my-workflow",
  className: "MyWorkflow"
});
```