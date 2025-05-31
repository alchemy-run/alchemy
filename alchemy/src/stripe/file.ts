import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface FileProps {
  file: any;
  purpose: Stripe.FileCreateParams.Purpose;
  fileLink?: {
    create: boolean;
    expiresAt?: number;
    metadata?: Record<string, string>;
  };
}

export interface File extends Resource<"stripe::File"> {
  id: string;
  object: "file";
  created: number;
  expiresAt?: number;
  filename?: string;
  links?: {
    object: "list";
    data: Array<{
      id: string;
      object: "file_link";
      created: number;
      expired: boolean;
      expiresAt?: number;
      file: string;
      livemode: boolean;
      metadata: Record<string, string>;
      url?: string;
    }>;
    hasMore: boolean;
    url: string;
  };
  purpose: Stripe.File.Purpose;
  size: number;
  title?: string;
  type?: string;
  url?: string;
  livemode: boolean;
}

export const File = Resource(
  "stripe::File",
  async function (
    this: Context<File>,
    _id: string,
    props: FileProps,
  ): Promise<File> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      return this.destroy();
    }

    try {
      let file: Stripe.File;

      if (this.phase === "update" && this.output?.id) {
        file = await stripe.files.retrieve(this.output.id);
      } else {
        file = await stripe.files.create({
          file: props.file,
          purpose: props.purpose,
        });
      }

      return this({
        id: file.id,
        object: file.object,
        created: file.created,
        expiresAt: file.expires_at || undefined,
        filename: file.filename || undefined,
        links: file.links
          ? {
              object: file.links.object,
              data: file.links.data.map((link) => ({
                id: link.id,
                object: link.object,
                created: link.created,
                expired: link.expired,
                expiresAt: link.expires_at || undefined,
                file: typeof link.file === "string" ? link.file : link.file.id,
                livemode: link.livemode,
                metadata: link.metadata,
                url: link.url || undefined,
              })),
              hasMore: file.links.has_more,
              url: file.links.url,
            }
          : undefined,
        purpose: file.purpose as Stripe.File.Purpose,
        size: file.size,
        title: file.title || undefined,
        type: file.type || undefined,
        url: file.url || undefined,
        livemode: true,
      });
    } catch (error) {
      console.error("Error creating/retrieving file:", error);
      throw error;
    }
  },
);
