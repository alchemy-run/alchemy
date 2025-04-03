# ShadcnComponent

The ShadcnComponent resource allows you to add [Shadcn UI components](https://ui.shadcn.com) to your project, providing a streamlined way to integrate UI elements with customizable options.

# Minimal Example

```ts
import { ShadcnComponent } from "alchemy/web";

const buttonComponent = await ShadcnComponent("button", {
  name: "button",
  cwd: "my-project",
});
```

# Create the ShadcnComponent

```ts
import { ShadcnComponent } from "alchemy/web";

// Add a Shadcn UI component to a project
const cardComponent = await ShadcnComponent("card", {
  name: "card",
  cwd: "my-project",
  force: true, // Force overwrite if the component already exists
  silent: false, // Show output during installation
});
```