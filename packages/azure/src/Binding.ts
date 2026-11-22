/**
 * Compatibility names for modules that have not moved to `AzureBindings.ts`
 * yet. Bindings reach their host through `AzureBindings.Bind`; nothing here
 * calls `host.bind` or keeps a list of host types.
 */
import type { HostBinding, HostRoleAssignment } from "./AzureBindings.ts";

/** @deprecated Use `AzureBindings.HostRoleAssignment`. */
export type AzureRoleAssignmentBinding = HostRoleAssignment;

/**
 * The binding data an Azure host's provider receives: env vars plus role
 * assignments for the host's managed identity.
 *
 * @deprecated Use `AzureBindings.HostBinding`.
 */
export interface AzureBindingContract {
  env?: Record<string, string>;
  roleAssignments?: AzureRoleAssignmentBinding[];
}

export type { HostBinding };

/** Decode the five predefined XML entities. */
export const xmlDecode = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Text of the first `<tag>` element inside `xml`, decoded. */
export const xmlField = (xml: string, tag: string) => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] === undefined ? undefined : xmlDecode(match[1]);
};

/** Bodies of every `<tag>…</tag>` element inside `xml`. */
export const xmlElements = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
