import { Document } from "../ai";
import { alchemy } from "../alchemy";
import type { Folder } from "../fs";

export interface GettingStartedProps {
  /**
   * The output directory for the getting started document.
   */
  path: string | Folder;
}

export type GettingStarted = Document;

export async function GettingStarted({
  path: outFile,
}: GettingStartedProps): Promise<Document> {
  return Document(`docs/getting-started`, {
    title: "Getting Started with Alchemy",
    path: typeof outFile === "string" ? outFile : outFile.path,
    model: {
      id: "claude-3-5-sonnet-latest",
      provider: "anthropic",
    },
    prompt: await alchemy`
      You are a technical writer creating a getting started guide for Alchemy, an infrastructure as code (IaC) framework.
      See ${alchemy.file("./README.md")} to understand the overview of Alchemy.
      See ${alchemy.file("./.cursorrules")} to better understand the structure and conventions of Alchemy.

      See ${alchemy.file("./alchemy/test/cloudflare/worker.test.ts")} for an example of how testing works.

      Write a comprehensive getting started guide for Alchemy that covers the following topics:
      
      # Getting Started with Alchemy
      
      (Brief introduction to Alchemy as an infrastructure as code framework)
      
      ## Installation
      
      \`\`\`bash
      # Install Alchemy
      bun add alchemy
      \`\`\`
      
      ## Creating Your First Alchemy Project
      
      (Step-by-step guide to creating a basic Alchemy project)
      
      \`\`\`ts
      // Example of a simple Alchemy project
      import alchemy from "alchemy";
      
      // Sample code here
      \`\`\`
      
      ## Core Concepts
      
      ### Resources
      
      (Explanation of Alchemy resources and how they work)
      
      \`\`\`ts
      // Example of creating a resource
      \`\`\`
      
      ### Context
      
      (Explanation of Alchemy context and lifecycle management)
      
      \`\`\`ts
      // Example of working with context
      \`\`\`
      
      ## Working with Secrets
      
      (How to handle secrets in Alchemy)
      
      \`\`\`ts
      // Example of using alchemy.secret()
      const apiKey = alchemy.secret("API_KEY");
      \`\`\`
      
      ## Testing
      
      (How to test Alchemy resources)
      
      \`\`\`ts
      // Example of testing Alchemy resources
      \`\`\`
      
      ## Deployment
      
      (How to deploy resources with Alchemy)
      
      \`\`\`ts
      // Example of deployment
      \`\`\`
      
      ## Next Steps
      
      (Where to go next to learn more about Alchemy)
      
      > [!CAUTION]
      > Avoid the temptation to over explain or over describe. Focus on concise, simple, high value snippets.
      
      > [!TIP]
      > Make sure the examples follow a natural progression from minimal examples to more complex use cases.
    `,
  });
}
