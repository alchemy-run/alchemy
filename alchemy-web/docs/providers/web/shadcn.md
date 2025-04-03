# ShadcnUI

The ShadcnUI component allows you to integrate [Shadcn UI](https://ui.shadcn.com) into your project, providing a set of customizable UI components.

# Minimal Example

```ts
import { ShadcnUI } from "alchemy/web";

const shadcn = await ShadcnUI("my-shadcn", {
  cwd: "my-project",
  tailwind: true,  // Tailwind must be installed separately
  react: true     // React must be installed separately
});
```

# Create the ShadcnUI

```ts
import { ShadcnUI } from "alchemy/web";

const shadcn = await ShadcnUI("custom-shadcn", {
  cwd: "my-project",
  baseColor: "zinc",
  force: true,
  components: ["button", "card", "input"],
  tailwind: true,  // Tailwind must be installed separately
  react: true     // React must be installed separately
});
```