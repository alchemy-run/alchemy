import yaml from "yaml";

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
export interface HomePage {
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
 * Parse YAML frontmatter to home page config
 */
export function parseHomePage(content: string): HomePage {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("Invalid frontmatter format");
  }
  return yaml.parse(match[1]) as HomePage;
}
