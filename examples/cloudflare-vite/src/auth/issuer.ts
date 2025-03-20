import { issuer as openauthIssuer } from "@openauthjs/openauth";
import { GithubProvider } from "@openauthjs/openauth/provider/github";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { api } from "../api";
import { Subjects } from "../auth/subjects";

import { env } from "cloudflare:workers";

const storage = CloudflareStorage({
  namespace: env.AUTH_STORE as any,
});

// Create the OpenAuth issuer app
const issuer = openauthIssuer({
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
    // google: GoogleProvider({
    //   clientID: env.GOOGLE_CLIENT_ID ?? "",
    //   clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    //   scopes: ["email", "profile"],
    // }),
    // x: XProvider({
    //   clientID: env.X_CLIENT_ID ?? "",
    //   clientSecret: env.X_CLIENT_SECRET ?? "",
    //   scopes: ["users.read"],
    //   pkce: true, // X requires PKCE
    // }),
    // twitch: TwitchProvider({
    //   clientID: env.TWITCH_CLIENT_ID ?? "",
    //   clientSecret: env.TWITCH_CLIENT_SECRET ?? "",
    //   scopes: ["user:read:email"],
    // }),
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
    } else if (value.provider === "google") {
      // Get user data from Google
      const response = await fetch(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        {
          headers: {
            Authorization: `Bearer ${value.tokenset.access}`,
          },
        },
      );

      if (response.ok) {
        const data: any = await response.json();
        id = data.sub;
        name = data.name || "";
        email = data.email || "";
        avatar = data.picture || "";
      }
    } else if (value.provider === "x") {
      // Get user data from X (Twitter)
      const response = await fetch("https://api.twitter.com/2/users/me", {
        headers: {
          Authorization: `Bearer ${value.tokenset.access}`,
        },
      });

      if (response.ok) {
        const data: any = await response.json();
        id = data.data.id;
        name = data.data.name || "";
        email = ""; // X doesn't provide email directly
        avatar = ""; // Would need another API call to get profile image
      }
    } else if (value.provider === "twitch") {
      // Get user data from Twitch
      const response = await fetch("https://api.twitch.tv/helix/users", {
        headers: {
          Authorization: `Bearer ${value.tokenset.access}`,
          "Client-Id": env.TWITCH_CLIENT_ID || "",
        },
      });

      if (response.ok) {
        const data: any = await response.json();
        if (data.data && data.data.length > 0) {
          id = data.data[0].id;
          name = data.data[0].display_name || "";
          email = data.data[0].email || "";
          avatar = data.data[0].profile_image_url || "";
        }
      }
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

api.route("/*", issuer);
