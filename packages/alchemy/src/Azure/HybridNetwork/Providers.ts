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
  ConfigurationGroupValue,
  ConfigurationGroupValueProvider,
} from "./ConfigurationGroupValue.ts";
import { NetworkFunction, NetworkFunctionProvider } from "./NetworkFunction.ts";
import {
  NetworkFunctionDefinitionGroup,
  NetworkFunctionDefinitionGroupProvider,
} from "./NetworkFunctionDefinitionGroup.ts";
import {
  NetworkFunctionDefinitionVersion,
  NetworkFunctionDefinitionVersionProvider,
} from "./NetworkFunctionDefinitionVersion.ts";
import {
  NetworkServiceDesignGroup,
  NetworkServiceDesignGroupProvider,
} from "./NetworkServiceDesignGroup.ts";
import {
  NetworkServiceDesignVersion,
  NetworkServiceDesignVersionProvider,
} from "./NetworkServiceDesignVersion.ts";
import { Publisher, PublisherProvider } from "./Publisher.ts";
import { Site, SiteProvider } from "./Site.ts";
import {
  SiteNetworkService,
  SiteNetworkServiceProvider,
} from "./SiteNetworkService.ts";

export const resources = [
  ArtifactManifest,
  ArtifactStore,
  ConfigurationGroupSchema,
  ConfigurationGroupValue,
  NetworkFunction,
  NetworkFunctionDefinitionGroup,
  NetworkFunctionDefinitionVersion,
  NetworkServiceDesignGroup,
  NetworkServiceDesignVersion,
  Publisher,
  Site,
  SiteNetworkService,
];
export const layers = () =>
  Layer.mergeAll(
    ArtifactManifestProvider(),
    ArtifactStoreProvider(),
    ConfigurationGroupSchemaProvider(),
    ConfigurationGroupValueProvider(),
    NetworkFunctionProvider(),
    NetworkFunctionDefinitionGroupProvider(),
    NetworkFunctionDefinitionVersionProvider(),
    NetworkServiceDesignGroupProvider(),
    NetworkServiceDesignVersionProvider(),
    PublisherProvider(),
    SiteProvider(),
    SiteNetworkServiceProvider(),
  );
