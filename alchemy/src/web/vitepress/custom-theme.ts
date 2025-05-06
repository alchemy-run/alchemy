import { type } from "arktype";
import path from "node:path";
import type { ModelConfig } from "../../ai/client.js";
import { CSSFile } from "../../ai/css-file.js";
import { Data } from "../../ai/data.js";
import { TypeScriptFile } from "../../ai/typescript-file.js";
import { VueFile } from "../../ai/vue-file.js";
import { alchemy } from "../../alchemy.js";
import type { Context } from "../../context.js";
import { Folder } from "../../fs/folder.js";
import { Resource } from "../../resource.js";
import type { Secret } from "../../secret.js";

/**
 * Theme component props for customizing the layout
 */
export interface ThemeComponentProps {
  /**
   * Name of the component
   */
  name: string;

  /**
   * Description of what the component does
   */
  description: string;

  /**
   * Features or functionality to include in the component
   */
  features?: string[];
}

/**
 * Properties for creating or updating a VitePress custom theme
 */
export interface CustomThemeProps {
  /**
   * Output directory for the theme files
   */
  outDir: string;

  /**
   * Title of the theme
   */
  title: string;

  /**
   * Description of the theme
   */
  description: string;

  /**
   * Components to include in the theme
   */
  components?: ThemeComponentProps[];

  /**
   * Whether to include dark mode support
   * @default true
   */
  darkMode?: boolean;

  /**
   * Custom CSS variables for theming
   */
  customCssVars?: Record<string, string>;

  /**
   * Custom plugins to add to the theme
   */
  plugins?: string[];

  /**
   * User prompt describing the design of the theme
   */
  prompt: string;

  /**
   * Optional extension to the built-in system prompt
   */
  systemPromptExtension?: string;

  /**
   * Base URL for the OpenAI API
   * @default 'https://api.openai.com/v1'
   */
  baseURL?: string;

  /**
   * OpenAI API key to use for generating content
   * If not provided, will use OPENAI_API_KEY environment variable
   */
  apiKey?: Secret;

  /**
   * Model configuration for the AI generator
   */
  model?: ModelConfig;

  /**
   * Temperature for controlling randomness in generation
   * @default 0.7
   */
  temperature?: number;
}

/**
 * A generated file in the custom theme
 */
export interface ThemeFile {
  /**
   * Path to the file
   */
  path: string;

  /**
   * Content of the file
   */
  content: string;
}

/**
 * Output for the VitePress custom theme resource
 */
export interface CustomTheme
  extends CustomThemeProps,
    Resource<"vitepress::CustomTheme"> {
  /**
   * Path to the generated theme directory
   */
  themePath: string;

  /**
   * List of generated files
   */
  files: ThemeFile[];

  /**
   * Time at which the theme was created
   */
  createdAt: number;

  /**
   * Time at which the theme was last updated
   */
  updatedAt: number;
}

/**
 * Resource for generating a custom VitePress theme using AI.
 *
 * Generates the necessary theme files including:
 * - Theme entry file (index.ts)
 * - Layout component (Layout.vue)
 * - Additional components based on configuration
 * - Style sheets and utilities
 *
 * @example
 * // Create a basic custom theme
 * const theme = await CustomTheme("docs-theme", {
 *   outDir: "./.vitepress/theme",
 *   title: "My Custom Theme",
 *   description: "A clean, minimal theme for documentation",
 *   prompt: "Create a clean documentation theme with a sidebar and search"
 * });
 *
 * @example
 * // Create a theme with specific components
 * const complexTheme = await CustomTheme("blog-theme", {
 *   outDir: "./.vitepress/theme",
 *   title: "Blog Theme",
 *   description: "A theme for technical blogs",
 *   components: [
 *     {
 *       name: "PostList",
 *       description: "Component that displays a list of blog posts with pagination",
 *       features: ["thumbnail images", "post dates", "categories", "excerpts"]
 *     },
 *     {
 *       name: "TableOfContents",
 *       description: "Component that displays the current page's table of contents",
 *       features: ["sticky positioning", "active link highlighting"]
 *     }
 *   ],
 *   darkMode: true,
 *   prompt: "Create a modern blog theme with post listings and detailed article pages"
 * });
 *
 * @example
 * // Create a theme with custom CSS variables
 * const brandedTheme = await CustomTheme("branded-theme", {
 *   outDir: "./.vitepress/theme",
 *   title: "Branded Docs",
 *   description: "A themed documentation site with custom branding",
 *   customCssVars: {
 *     "--vp-c-brand": "#3a70b0",
 *     "--vp-c-brand-light": "#5785bc",
 *     "--vp-c-brand-lighter": "#79a1ce",
 *     "--vp-c-brand-dark": "#2c5989",
 *     "--vp-c-brand-darker": "#1e3d5c"
 *   },
 *   prompt: "Create a documentation theme with custom branding and color scheme"
 * });
 */
export const CustomTheme = Resource(
  "vitepress::CustomTheme",
  async function (
    this: Context<CustomTheme>,
    id: string,
    props: CustomThemeProps,
  ): Promise<CustomTheme> {
    // Handle deletion
    if (this.phase === "delete") {
      // No need to actually delete files, as they're not critical infrastructure
      // In a real implementation, you might want to clean up files
      return this.destroy();
    }

    // Ensure the output directory exists
    await Folder(props.outDir);

    // Create components directory if it doesn't exist
    await Folder(path.join(props.outDir, "components"));

    // Build the system prompt with optional extension
    const systemPrompt = `
You are creating a custom VitePress theme.

A VitePress custom theme consists of multiple files:
1. An entry file (index.ts or index.js) that exports the theme object
2. A Layout component (Layout.vue) that handles the overall page structure
3. Optional additional Vue components for specific functionality
4. Optional style files for theming and customization

The theme entry file must export an object with:
- Layout: The root layout component (required)
- enhanceApp: Function to enhance the Vue app (optional)
- extends: Another theme to extend (optional)

Follow these guidelines:
1. Use Vue 3 Composition API and <script setup> syntax
2. Ensure the theme is SSR-compatible
3. Use the useData() composable to access page and site data
4. Handle different page layouts (home, 404, regular pages)
5. Include proper TypeScript types
6. Use modern JavaScript/TypeScript features
7. Include clear comments explaining key functionality
8. Make components reusable and customizable
9. Include support for dark mode if requested

${props.systemPromptExtension || ""}
`;

    // Generate the theme entry file (index.ts)
    const indexFile = await TypeScriptFile(`${id}-index`, {
      path: path.join(props.outDir, "index.ts"),
      prompt: await alchemy`
Create a VitePress theme entry file (index.ts) for a theme named "${props.title}".

The theme should:
- Export a default theme object with the required properties
- Import the Layout component
- Include a proper enhanceApp function
- Include TypeScript types
- Have clear comments explaining the code

${props.description ? `Theme description: ${props.description}` : ""}
${props.plugins?.length ? `Include these plugins: ${props.plugins.join(", ")}` : ""}

The output should be a complete, well-structured TypeScript file.
`,
      system: `${systemPrompt}
You are writing a TypeScript entry file for a VitePress theme.`,
      baseURL: props.baseURL,
      apiKey: props.apiKey,
      model: props.model,
      temperature: props.temperature,
    });

    // Generate the Layout component
    const layoutFile = await VueFile(`${id}-layout`, {
      path: path.join(props.outDir, "Layout.vue"),
      prompt: await alchemy`
Create a Layout.vue component for a VitePress theme named "${props.title}".

The layout should:
- Use <script setup> with the Composition API
- Import and use the useData() composable
- Handle different page types (regular pages, home pages, 404 pages)
- Include a <Content /> component to render the page content
- Have a clean, modern design
- Include proper TypeScript types
- Use Vue's Teleport for elements like modals if needed

The layout should use modular components for different parts of the UI, such as:
- NavBar/Header component for navigation
- Sidebar component for documentation navigation
- Footer component
- Home page specific components (like hero sections)
- 404 page component

These components should be imported from the components directory.

${props.description ? `Theme description: ${props.description}` : ""}
${props.darkMode !== false ? "Include support for dark mode" : "Dark mode is not required"}

The layout should follow the user's requirements:
${props.prompt}

The output should be a complete, well-structured Vue component file.
`,
      system: `${systemPrompt}
You are writing a Vue component for a VitePress theme Layout.
Import smaller components from the components directory using relative paths (e.g., import NavBar from './components/NavBar.vue').
Break down the layout into logical components like NavBar, Sidebar, Footer, etc., which will be generated separately.`,
      baseURL: props.baseURL,
      apiKey: props.apiKey,
      model: props.model,
      temperature: props.temperature,
    });

    // Extract component imports from the Layout.vue file
    const componentImportsData = await Data(`${id}-component-imports`, {
      schema: type({
        components: type({
          name: type("string").describe(
            "Component name as used in the import statement (e.g., NavBar, Footer)",
          ),
          path: type("string").describe(
            "Import path as written in the import statement (e.g., './components/NavBar.vue')",
          ),
          purpose: type("string").describe(
            "A clear description of the component's purpose, functionality, and responsibilities in the layout",
          ),
        }).array(),
      }),
      prompt: await alchemy`
Analyze the following Layout.vue file and extract information about all the component imports:

${layoutFile.content}

For each component import:
1. Extract the component name (e.g., NavBar)
2. Extract the import path (e.g., ./components/NavBar.vue)
3. Infer the purpose of the component based on its name and usage in the file

Return a structured list of all component imports found in the file.
Only include components that are imported from local files (not from VitePress or other libraries).
Focus on components that are likely Vue components (.vue files).
`,
      system:
        "You are a code analyzer tasked with extracting component imports from a Vue file. Be precise and thorough in identifying all local component imports.",
      baseURL: props.baseURL,
      apiKey: props.apiKey,
      model: props.model,
      temperature: props.temperature || 0.2, // Lower temperature for more deterministic extraction
    });

    // Generate the detected components
    const autoComponentFiles = await Promise.all(
      componentImportsData.object.components.map(async (component) => {
        const componentName = component.name;
        const componentPath = component.path;
        const componentPurpose = component.purpose;

        // Extract the relative path from the import
        const relativePath = componentPath.startsWith("./")
          ? componentPath.slice(2) // Remove './'
          : componentPath.startsWith("/")
            ? componentPath.slice(1) // Remove '/'
            : componentPath;

        // Compute the full file path
        const fullPath = path.join(props.outDir, relativePath);

        return VueFile(`${id}-component-${componentName}`, {
          path: fullPath,
          prompt: await alchemy`
Create a Vue component named "${componentName}" for a VitePress theme.

Component purpose: ${componentPurpose}

The component should:
- Use <script setup> with the Composition API
- Have a clean, focused design for its specific purpose
- Include proper TypeScript types
- Be reusable and customizable
- Include clear comments explaining key functionality
- Fit seamlessly with the overall theme design described below

This component will be used in the following layout context:
${layoutFile.content}

${props.description ? `Theme description: ${props.description}` : ""}
${props.darkMode !== false ? "Include support for dark mode" : "Dark mode is not required"}

The component should follow the user's theme requirements:
${props.prompt}
`,
          system: `${systemPrompt}
You are writing a Vue component for a VitePress theme. This component (${componentName}) is intended to ${componentPurpose}.
Make sure it integrates well with the overall layout and theme style.`,
          baseURL: props.baseURL,
          apiKey: props.apiKey,
          model: props.model,
          temperature: props.temperature,
        });
      }),
    );

    // Generate user-specified components if provided
    const userComponentFiles = await Promise.all(
      (props.components || []).map(async (component) => {
        return VueFile(`${id}-user-component-${component.name}`, {
          path: path.join(props.outDir, "components", `${component.name}.vue`),
          prompt: await alchemy`
Create a Vue component named "${component.name}" for a VitePress theme.

Component description: ${component.description}

The component should:
- Use <script setup> with the Composition API
- Have a clean, focused design for its specific purpose
- Include proper TypeScript types
- Be reusable and customizable
- Include clear comments

${
  component.features?.length
    ? `Include these features:
${component.features.map((f) => `- ${f}`).join("\n")}`
    : ""
}

Make sure the component integrates well with the overall theme.

The output should be a complete, well-structured Vue component file.
`,
          system: `${systemPrompt}
You are writing a Vue component for a VitePress theme.`,
          baseURL: props.baseURL,
          apiKey: props.apiKey,
          model: props.model,
          temperature: props.temperature,
        });
      }),
    );

    // Generate styles file
    const stylesFile = await CSSFile(`${id}-styles`, {
      path: path.join(props.outDir, "styles.css"),
      prompt: await alchemy`
Create a CSS styles file for a VitePress theme named "${props.title}".

The styles should:
- Define a cohesive set of styles for the theme
- Include CSS variables for customization
- Use modern CSS features
- Be well-organized with clear comments
${props.darkMode !== false ? "- Include dark mode variants using :root.dark selectors" : ""}

${props.description ? `Theme description: ${props.description}` : ""}

${
  props.customCssVars
    ? `Include these custom CSS variables:
${Object.entries(props.customCssVars)
  .map(([key, value]) => `${key}: ${value};`)
  .join("\n")}`
    : ""
}

Style according to the user's requirements:
${props.prompt}

The output should be a complete, well-structured CSS file.
`,
      system: `${systemPrompt}
You are writing CSS styles for a VitePress theme.`,
      baseURL: props.baseURL,
      apiKey: props.apiKey,
      model: props.model,
      temperature: props.temperature,
    });

    // Collect all generated files
    const allFiles = [
      indexFile,
      layoutFile,
      ...autoComponentFiles,
      ...userComponentFiles,
      stylesFile,
    ];

    // Create file objects for resource output
    const files = allFiles.map((file) => ({
      path: file.path,
      content: file.content,
    }));

    // Get the current timestamp
    const now = Date.now();

    // Return the resource using this() to construct output
    return this({
      ...props,
      themePath: props.outDir,
      files,
      createdAt: this.output?.createdAt || now,
      updatedAt: now,
    });
  },
);
