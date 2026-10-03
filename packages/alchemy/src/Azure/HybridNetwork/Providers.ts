import * as Layer from "effect/Layer";
import {
  ArtifactManifest,
  ArtifactManifestProvider,
} from "./ArtifactManifest.ts";
import { ArtifactStore, ArtifactStoreProvider } from "./ArtifactStore.ts";
import {
  ConfigurationGroupSchema,
  ConfigurationGroupSchemaProvider,
} from "./ConfigurationGroupSchema.ts";
import {
  NetworkFunctionDefinitionGroup,
  NetworkFunctionDefinitionGroupProvider,
} from "./NetworkFunctionDefinitionGroup.ts";
import {
  NetworkServiceDesignGroup,
  NetworkServiceDesignGroupProvider,
} from "./NetworkServiceDesignGroup.ts";
import { Publisher, PublisherProvider } from "./Publisher.ts";
import { Site, SiteProvider } from "./Site.ts";

export const resources = [
  ArtifactManifest,
  ArtifactStore,
  ConfigurationGroupSchema,
  NetworkFunctionDefinitionGroup,
  NetworkServiceDesignGroup,
  Publisher,
  Site,
];
export const layers = () =>
  Layer.mergeAll(
    ArtifactManifestProvider(),
    ArtifactStoreProvider(),
    ConfigurationGroupSchemaProvider(),
    NetworkFunctionDefinitionGroupProvider(),
    NetworkServiceDesignGroupProvider(),
    PublisherProvider(),
    SiteProvider(),
  );
