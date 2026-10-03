import path from "node:path";

export function containsPath(
  parent: string,
  child: string,
  pathImplementation: Pick<typeof path, "relative" | "isAbsolute" | "sep"> = path,
): boolean {
  const relativePath = pathImplementation.relative(parent, child);

  // Windows returns an absolute path when the paths are on different drives.
  if (pathImplementation.isAbsolute(relativePath)) {
    return false;
  }

  return relativePath === "" || (
    relativePath !== ".." && !relativePath.startsWith(`..${pathImplementation.sep}`)
  );
}
