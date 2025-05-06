import yaml from "yaml";
import { Document } from "../../ai/document.js";
import { alchemy } from "../../alchemy.js";
import { StaticTextFile } from "../../fs/static-text-file.js";
import type { Secret } from "../../secret.js";

/**
 * Image that can be themed for light/dark mode
 */
export interface ThemeableImage {
  /**
   * Image source URL
   */
  src?: string;

  /**
   * Image alt text
   */
  alt?: string;

  /**
   * Light theme image URL
   */
  light?: string;

  /**
   * Dark theme image URL
   */
  dark?: string;
}

/**
 * Hero action button configuration
 */
export interface HeroAction {
  /**
   * Color theme of the button
   * @default "brand"
   */
  theme?: "brand" | "alt";

  /**
   * Label of the button
   */
  text: string;

  /**
   * Destination link of the button
   */
  link: string;

  /**
   * Link target attribute
   */
  target?: string;

  /**
   * Link rel attribute
   */
  rel?: string;
}

/**
 * Hero section configuration
 */
export interface Hero {
  /**
   * The string shown top of text. Comes with brand color
   * and expected to be short, such as product name.
   */
  name?: string;

  /**
   * The main text for the hero section. This will be defined
   * as h1 tag.
   */
  text: string;

  /**
   * Tagline displayed below text
   */
  tagline?: string;

  /**
   * The image displayed next to the text and tagline area
   */
  image?: string | ThemeableImage;

  /**
   * Action buttons to display in home hero section
   */
  actions?: HeroAction[];
}

/**
 * Feature item configuration
 */
export interface Feature {
  /**
   * Show icon on each feature box
   */
  icon?: string | ThemeableImage;

  /**
   * Title of the feature
   */
  title: string;

  /**
   * Details of the feature
   */
  details: string;

  /**
   * Link when clicked on feature component
   */
  link?: string;

  /**
   * Link text to be shown inside feature component
   */
  linkText?: string;

  /**
   * Link rel attribute
   */
  rel?: string;

  /**
   * Link target attribute
   */
  target?: string;
}

/**
 * VitePress home page configuration
 */
export interface HomePageConfig {
  /**
   * Use home page layout
   */
  layout: "home";

  /**
   * Hero section configuration
   */
  hero?: Hero;

  /**
   * Features section configuration
   */
  features?: Feature[];

  /**
   * Whether to apply default markdown styles
   * @default true
   */
  markdownStyles?: boolean;
}

/**
 * Properties for creating or updating a VitePress HomePage
 */
export interface HomePageProps {
  /**
   * Output directory for the home page markdown file
   */
  outFile: string;

  /**
   * Title of the home page document
   */
  title: string;

  /**
   * Hero section configuration
   */
  hero?: Hero;

  /**
   * Features section configuration
   */
  features?: Feature[];

  /**
   * User prompt describing the design of the home page
   */
  prompt?: string;

  /**
   * Optional extension to the built-in system prompt
   */
  system?: string;

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
  model?: import("../../ai/client").ModelConfig;

  /**
   * Temperature for controlling randomness in generation
   * @default 0.7
   */
  temperature?: number;
}

/**
 * Output type for the HomePage resource
 */
export type HomePage = StaticTextFile | Document;

/**
 * Parse YAML frontmatter to home page config
 */
export function parseHomePage(content: string): HomePageConfig {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("Invalid frontmatter format");
  }
  return yaml.parse(match[1]) as HomePageConfig;
}

/**
 * Resource for generating a VitePress homepage using AI.
 * Creates an index.md file with the appropriate frontmatter and content
 * based on the provided prompt and configuration.
 *
 * @example
 * // Create a basic home page with just a prompt
 * const homePage = await HomePage("docs-home", {
 *   outDir: "./docs",
 *   title: "My Project Documentation",
 *   prompt: "Create a welcoming homepage for a JavaScript utility library with modern design"
 * });
 *
 * @example
 * // Create a home page with hero and features configuration
 * const detailedHome = await HomePage("product-home", {
 *   outDir: "./website",
 *   title: "Product Landing Page",
 *   prompt: "Create an engaging product page for our cloud database service",
 *   hero: {
 *     name: "CloudDB",
 *     text: "The database built for the cloud era",
 *     tagline: "Scalable, reliable, and developer-friendly",
 *     image: "/images/cloud-db-logo.png",
 *     actions: [
 *       { text: "Get Started", link: "/guide/", theme: "brand" },
 *       { text: "View on GitHub", link: "https://github.com/org/cloud-db" }
 *     ]
 *   },
 *   features: [
 *     {
 *       icon: "🚀",
 *       title: "Lightning Fast",
 *       details: "Optimized for performance at any scale"
 *     },
 *     {
 *       icon: "🔒",
 *       title: "Secure by Default",
 *       details: "Enterprise-grade security built in"
 *     }
 *   ]
 * });
 *
 * @example
 * // Create a home page with custom model settings
 * const customHome = await HomePage("docs-home", {
 *   outDir: "./docs",
 *   title: "API Documentation",
 *   prompt: "Create a technical homepage for our REST API documentation",
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai"
 *   },
 *   temperature: 0.3,
 *   systemPromptExtension: "Make sure to use technical terminology appropriate for developers."
 * });
 */
export async function HomePage(
  id: string,
  props: HomePageProps,
): Promise<HomePage> {
  // Build the system prompt with optional extension
  const systemPrompt = `
You are creating a VitePress homepage (index.md file).

VitePress uses YAML frontmatter to configure the homepage.
The homepage must have "layout: home" in its frontmatter.

The homepage can include:
- A hero section with name, text, tagline, image, and action buttons
- A features section with multiple feature items (title, icon, details)
- Additional markdown content below the frontmatter

Follow these guidelines:
1. Start with YAML frontmatter (--- at beginning and end)
2. Include "layout: home" in the frontmatter
3. Use the provided hero and features configuration if supplied
4. Add any additional sections or content based on the user's prompt
5. Create visually appealing, well-structured content
6. Ensure all links are properly formatted
7. Use appropriate markdown formatting for headings, lists, etc.

${props.system || ""}
`;

  // Convert hero and features to YAML strings if provided
  const heroYaml = props.hero ? JSON.stringify(props.hero, null, 2) : "";
  const featuresYaml = props.features
    ? JSON.stringify(props.features, null, 2)
    : "";

  if (props.prompt) {
    return Document(id, {
      title: props.title,
      path: props.outFile,
      baseURL: props.baseURL,
      apiKey: props.apiKey,
      model: props.model ?? {
        id: "claude-3-7-sonnet-latest",
        provider: "anthropic",
      },
      temperature: props.temperature ?? 0.7,
      prompt: await alchemy`
    ${systemPrompt}
    
    Create a VitePress homepage based on the following description:
    ${props.prompt}
    
    ${
      props.hero
        ? `Use this hero section configuration:
    \`\`\`json
    ${heroYaml}
    \`\`\``
        : ""
    }
    
    ${
      props.features
        ? `Use these features:
    \`\`\`json
    ${featuresYaml}
    \`\`\``
        : ""
    }
        
        The output should be a complete index.md file with proper YAML frontmatter and markdown content.
        `,
    });
  }
  return StaticTextFile(
    id,
    props.outFile,
    `---
${yaml.stringify({
  layout: "home",
  name: props.title,
  hero: props.hero,
  features: props.features,
})}
---
`,
  );
}
