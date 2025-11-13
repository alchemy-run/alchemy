import { Resource } from "../../resource.ts";

export type BucketProps = {
  name?: string;
  storageClass?: Bucket.StorageClass;
  jurisdiction?: Bucket.Jurisdiction;
  locationHint?: Bucket.Location;
};

export type BucketAttr<Props extends BucketProps> = {
  name: Props["name"] extends string ? Props["name"] : string;
  storageClass: Props["storageClass"] extends Bucket.StorageClass
    ? Props["storageClass"]
    : "Standard";
  jurisdiction: Props["jurisdiction"] extends Bucket.Jurisdiction
    ? Props["jurisdiction"]
    : "default";
  location: Bucket.Location | undefined;
  accountId: string;
};

export interface Bucket<
  ID extends string = string,
  Props extends BucketProps = BucketProps,
> extends Resource<"Cloudflare.R2.Bucket", ID, Props, BucketAttr<Props>> {}

export const Bucket = Resource<{
  <const ID extends string, const Props extends BucketProps>(
    id: ID,
    props?: Props,
  ): Bucket<ID, Props>;
}>("Cloudflare.R2.Bucket");

export declare namespace Bucket {
  export type StorageClass = "Standard" | "InfrequentAccess";
  export type Jurisdiction = "default" | "eu" | "fedramp";
  export type Location = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
}
