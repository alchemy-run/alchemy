// @ts-nocheck
import { issuer as openauthIssuer } from "@openauthjs/openauth";
import { GithubProvider } from "@openauthjs/openauth/provider/github";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { env } from "cloudflare:workers";
import { Subjects } from "../auth/subjects.js";

const storage = CloudflareStorage({
  namespace: env.AUTH_STORE as any, // TODO: what is openauth doing weird with types?
});

// Create the OpenAuth issuer app
export const issuer = openauthIssuer({
  // Configure providers
  ttl: {
    // see: https://github.com/toolbeam/openauth/issues/133
    reuse: 61,
  },
  providers: {
    github: GithubProvider({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      scopes: ["user:email", "read:user"],
    }),
  },

  // Configure Cloudflare KV for storage
  storage,

  // Define our subjects (user data structure)
  subjects: Subjects,

  // Handle successful authentication
  async success(ctx, value) {
    let id = "";
    let name = "";
    let email = "";
    let avatar = "";

    // Handle different provider responses
    if (value.provider === "github") {
      // Get user data from GitHub
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${value.tokenset.access}`,
          "User-Agent": "gorogue.sh",
        },
      });

      if (response.ok) {
        const data: any = await response.json();
        console.log(data);
        id = data.id.toString();
        name = data.name || data.login;
        email = data.email || "";
        avatar = data.avatar_url || "";
      } else {
        console.log("Error Getting User Data", await response.text());
      }
    } else {
      throw new Error(`Unsupported provider: ${value.provider}`);
    }

    // Create the user subject with the data
    return ctx.subject("user", {
      id,
      name,
      email,
      avatar,
    });
  },
});
