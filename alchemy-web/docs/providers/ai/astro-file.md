# Astro File

The AstroFile resource lets you generate [Astro](https://astro.build) components and pages using AI models.

# Minimal Example

Creates a basic Astro component with AI-generated code.

```ts
import { AstroFile } from "alchemy/ai";

const header = await AstroFile("header", {
  path: "./src/components/Header.astro",
  prompt: "Generate a simple header component with a logo and navigation menu"
});
```

# Create an Astro Component with Context

```ts
import { AstroFile } from "alchemy/ai";

const blogPost = await AstroFile("blog-post", {
  path: "./src/pages/blog/[slug].astro",
  prompt: await alchemy`
    Create an Astro blog post page that:
    - Uses getStaticPaths to generate pages from a CMS
    - Renders markdown content
    - Includes author info and publication date
    
    Use these types:
    ${alchemy.file("src/types/Blog.ts")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```

# Generate a Layout with Custom System Prompt

```ts
import { AstroFile } from "alchemy/ai";

const layout = await AstroFile("main-layout", {
  path: "./src/layouts/MainLayout.astro", 
  prompt: "Create a main layout with SEO metadata, header and footer slots",
  system: "You are an expert Astro developer. Create a single layout file with proper typing.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```