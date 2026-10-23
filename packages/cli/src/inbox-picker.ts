import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { InboxInspectionError, inspectRegisteredInbox, type NamedInbox } from "./inbox-catalog";
import { getViewerStatus } from "./viewer-status";

export class InboxPickerCancelledError extends Error {
  constructor() {
    super("Inbox selection cancelled.");
    this.name = "InboxPickerCancelledError";
  }
}

export async function promptForInbox(
  inboxes: readonly NamedInbox[],
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  if (input.readableEnded || input.destroyed) {
    throw new InboxPickerCancelledError();
  }

  const choices = await Promise.all(inboxes.map(async (inbox) => {
    try {
      await inspectRegisteredInbox(inbox);
    } catch (error) {
      const state = error instanceof InboxInspectionError ? error.state : "incompatible";
      return { inbox, isSelectable: false, label: `library ${state}; unavailable` };
    }

    return { inbox, isSelectable: true, label: `viewer ${await inspectViewerState(inbox)}` };
  }));

  if (input.readableEnded || input.destroyed) {
    throw new InboxPickerCancelledError();
  }

  output.write("Choose an inbox for this operation:\n");
  for (const [index, choice] of choices.entries()) {
    output.write(`  #${index + 1} ${choice.inbox.name}\t${choice.label}\n`);
  }
  output.write("Enter an exact name or #number. :q or Ctrl-C cancels; q also cancels unless an inbox is named q.\n");

  const prompt = createInterface({ input, output });
  const closePrompt = () => prompt.close();
  input.once("close", closePrompt);
  output.once("error", closePrompt);
  try {
    return await new Promise<string>((resolve, reject) => {
      let hasSettled = false;
      const finish = (name?: string) => {
        if (hasSettled) {
          return;
        }

        hasSettled = true;
        if (name === undefined) {
          reject(new InboxPickerCancelledError());
          return;
        }

        resolve(name);
      };

      prompt.once("SIGINT", () => finish());
      prompt.once("close", () => finish());
      prompt.once("error", reject);
      prompt.on("line", (line: string) => {
        if (hasSettled) {
          return;
        }

        if (input.readableEnded) {
          finish();
          return;
        }

        const answer = line.trim();
        const namedChoice = choices.find((candidate) => candidate.inbox.name === answer);
        if (answer === ":q" || (answer === "q" && !namedChoice)) {
          finish();
          return;
        }

        const choice = namedChoice
          ?? (/^#[1-9][0-9]*$/.test(answer) ? choices[Number(answer.slice(1)) - 1] : undefined);
        if (!choice || !choice.isSelectable) {
          output.write(choice ? "That library is unavailable. Choose another inbox or :q to cancel.\n" : "Enter a listed name or #number, or :q to cancel.\n");
          prompt.prompt();
          return;
        }

        finish(choice.inbox.name);
      });
      prompt.setPrompt("Inbox: ");
      prompt.prompt();
    });
  } finally {
    prompt.close();
    input.off("close", closePrompt);
    output.off("error", closePrompt);
  }
}

async function inspectViewerState(inbox: NamedInbox): Promise<string> {
  try {
    const options = { refreshLanUrls: false, readOnly: true, instanceId: inbox.instanceId };
    const status = await getViewerStatus(inbox.home, undefined, options);
    if (status.state === "stopped" && status.reason) {
      return "incompatible";
    }

    return status.state === "running" && status.pid === undefined ? "conflict" : status.state;
  } catch {
    return "incompatible";
  }
}
