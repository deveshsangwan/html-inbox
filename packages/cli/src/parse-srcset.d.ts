declare module "@fisker/parse-srcset" {
  interface SrcsetCandidate {
    url: string;
    w?: number;
    d?: number;
    h?: number;
  }

  interface ParseSrcsetOptions {
    logger?: { error?: (message: string) => void };
  }

  function parseSrcset(value: string, options?: ParseSrcsetOptions): SrcsetCandidate[];

  export = parseSrcset;
}
