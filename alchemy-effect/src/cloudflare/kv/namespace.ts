import { Resource } from "../../resource.ts";

export type NamespaceProps = {
  title?: string;
};

export type NamespaceAttr<Props extends NamespaceProps> = {
  title: Props["title"] extends string ? Props["title"] : string;
  namespaceId: string;
  supportsUrlEncoding?: boolean;
  accountId: string;
};

export interface Namespace<
  ID extends string = string,
  Props extends NamespaceProps = NamespaceProps,
> extends Resource<
    "Cloudflare.KV.Namespace",
    ID,
    Props,
    NamespaceAttr<Props>
  > {}

export const Namespace = Resource<{
  <const ID extends string, const Props extends NamespaceProps>(
    id: ID,
    props: Props,
  ): Namespace<ID, Props>;
}>("Cloudflare.KV.Namespace");
