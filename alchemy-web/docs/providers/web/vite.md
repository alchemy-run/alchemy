# ViteProject

The ViteProject component allows you to create and configure a [Vite](https://vitejs.dev/) project with various templates and optional integrations like Tailwind CSS, Tanstack Router, and Shadcn UI.

# Minimal Example

```ts
import { ViteProject } from "alchemy/web";

const myViteApp = await ViteProject("my-vite-app", {
  name: "my-vite-app",
  template: "react-ts"
});
```

# Create the ViteProject

```ts
import { ViteProject } from "alchemy/web";

// Create a Vite project with React and Tailwind CSS
const reactTailwindApp = await ViteProject("react-tailwind-app", {
  name: "react-tailwind-app",
  template: "react-ts",
  tailwind: true
});

// Create a Vite project with Shadcn UI components
const shadcnApp = await ViteProject("shadcn-app", {
  name: "shadcn-app",
  template: "react-ts",
  shadcn: {
    baseColor: "zinc",
    components: ["button", "card", "input"]
  }
});
```