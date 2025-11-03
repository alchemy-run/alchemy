import { Resource } from "alchemy-effect";

export type KVProps = {
  title?: string;
};

export type KVAttr<Props extends KVProps> = {
  title: Props["title"] extends string ? Props["title"] : string;
  namespaceId: string;
};

export interface KV<ID extends string, Props extends KVProps>
  extends Resource<"Cloudflare.KVNamespace", ID, Props, KVAttr<Props>> {}

export const KV = Resource<{
  <const ID extends string, const Props extends KVProps>(
    id: ID,
    props: Props,
  ): KV<ID, Props>;
}>("Cloudflare.KVNamespace");
