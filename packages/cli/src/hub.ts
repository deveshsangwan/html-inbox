import { parseHubConfig, type HubConfiguration } from "./hub-config";
import { LocalDocumentSource } from "./local-document-source";
import { createDocumentDeleter } from "./document-deletion";
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
  const mounts = Promise.all(config.sources.map(async ({ name, home, instanceId }) => {
    const deletion = await createDocumentDeleter({ home, instanceId }).then(
      (deleteDocument) => ({ deleteDocument }),
      (error: unknown) => ({ deleteDocument: async () => { throw error; } }),
    );

    return { name, source: new LocalDocumentSource({ home, instanceId }, maximumDocumentBytes), ...deletion };
  }));

  return mounts.then((sources) => startHubHttpServer(sources, network, { inboxName: config.name }));
}
