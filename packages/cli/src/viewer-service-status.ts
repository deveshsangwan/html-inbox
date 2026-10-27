import { assertViewerServiceUser, executeViewerServiceUser, preflightViewerServiceHome } from "./viewer-service-owner";
import { defaultRuntime } from "./viewer-service-runtime";
import { isRecord } from "./validation";
import { isValidPid } from "./viewer-records";
import type { ViewerServiceDefinition } from "./viewer-service-definition";

export async function queryViewerServiceProcess(
  definition: ViewerServiceDefinition,
  lookupUser = defaultRuntime().lookupUser,
): Promise<{ state: string; pid?: number }> {
  assertViewerServiceUser(definition.user);
  if (process.getuid?.() === 0) {
    const current = await lookupUser(definition.user.name);
    if (current.name !== definition.user.name || current.uid !== definition.user.uid || current.gid !== definition.user.gid || current.home !== definition.user.home) {
      throw new Error("Installed service account binding differs from the current normal account");
    }
  }

  await preflightViewerServiceHome({ home: definition.home, user: definition.user });
  const environment = { ...definition.environment, HTML_INBOX_HOME: definition.home, HTML_INBOX_PORT: String(definition.port) };
  const query = (json: boolean) => executeViewerServiceUser(definition.user, definition.nodePath, definition.cliPath,
    ["viewer", "status", ...(json ? ["--json"] : [])], environment);

  let result = await query(true);
  // Older installed service CLIs already emit JSON and reject the new format flag.
  if (result.error && /^html-inbox: Unknown option ['"]--json['"]/m.test(result.stderr)) {
    result = await query(false);
  }

  if (result.error) {
    throw new Error(
      `Viewer service status failed as ${definition.user.name}: ${(result.stderr.trim() || result.error.message).slice(0, 2000)}`,
      { cause: result.error },
    );
  }

  const status: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(status) ||
    typeof status.state !== "string" ||
    !["running", "stopped", "conflict", "incompatible"].includes(
      status.state,
    ) ||
    (status.pid !== undefined && !isValidPid(status.pid))
  ) {
    throw new Error("Viewer service returned malformed normal-user status");
  }

  return {
    state: status.state,
    ...(isValidPid(status.pid) ? { pid: status.pid } : {}),
  };
}
