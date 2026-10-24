import { isIP } from "node:net";

/** Configuration validation performs no bind, lookup, interface discovery or fallback. */
export function validateSyncListenHost(host: string): string {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    if (octets[0] === 0 || octets[0] >= 224 || host === "255.255.255.255") {
      throw new Error("Sync ingestion requires an explicit literal unicast IP address");
    }

    return host;
  }

  if (family === 6 && !host.includes("%")) {
    const normalized = new URL(`https://[${host}]`).hostname.slice(1, -1);
    if (normalized !== "::" && !normalized.startsWith("ff") && !normalized.startsWith("::ffff:")) {
      return normalized;
    }

    if (normalized.startsWith("::ffff:")) {
      const words = normalized.slice(7).split(":").map((word) => Number.parseInt(word, 16));
      if (words.length === 2) {
        validateSyncListenHost(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
        return normalized;
      }
    }
  }

  throw new Error("Sync ingestion requires an explicit literal unicast IP address");
}
