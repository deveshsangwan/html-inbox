import { parseHubConfig, type HubConfiguration } from "./hub-config";
import { LocalDocumentSource } from "./local-document-source";
import { getMaxDocumentBytes } from "./publish-input";
import { startHubHttpServer, type ViewerReaderServer } from "./viewer-http-server";
import { resolveViewerNetworkConfig, type ViewerNetworkOptions } from "./viewer-network";

export const DEFAULT_HUB_PORT = 3218;

export function startHub(
  configuration: HubConfiguration,
  networkConfiguration: number | ViewerNetworkOptions = DEFAULT_HUB_PORT,
): Promise<ViewerReaderServer> {
  const config = parseHubConfig(configuration);
  const network = resolveViewerNetworkConfig(networkConfiguration);
  if (network.exposure === "tailscale") {
    throw new Error("Hub exposure must be loopback or explicit LAN");
  }

  const maximumDocumentBytes = getMaxDocumentBytes();
  const mounts = config.sources.map(({ name, home, instanceId }) => ({
    name,
    source: new LocalDocumentSource({ home, instanceId }, maximumDocumentBytes),
  }));

  return startHubHttpServer(mounts, network, { inboxName: config.name });
}
