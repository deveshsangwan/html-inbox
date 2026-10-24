import type { FileHandle } from "node:fs/promises";

export async function readBoundedFile(
  file: FileHandle,
  maximumBytes: number,
  limitMessage: string,
  onBytesRead?: (bytesRead: number) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - byteLength + 1));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, byteLength);
    }

    onBytesRead?.(bytesRead);

    byteLength += bytesRead;
    if (byteLength > maximumBytes) {
      throw new Error(limitMessage);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
}
