import type { DocumentReadView } from "./documents";

/** One admitted read, no queue. Closing waits for native reads before disposal. */
export async function withDocumentReadView<T>(
  reader: DocumentReadView,
  operation: (view: DocumentReadView) => Promise<T>,
  signal?: AbortSignal,
  dispose?: () => void,
): Promise<T> {
  let current: DocumentReadView | undefined = reader;
  let pending: Promise<unknown> | undefined;
  let isClosed = false;
  let hasCallbackFailed = false;
  let callbackFailure: unknown;
  const stopAdmission = () => { isClosed = true; };

  async function read<Result>(action: (source: DocumentReadView) => Promise<Result>): Promise<Result> {
    if (isClosed || !current) {
      throw new Error("Document read view is closed");
    }

    signal?.throwIfAborted();
    if (pending) {
      throw new Error("Document read view already has an active read");
    }

    const source = current;
    const admitted = Promise.resolve().then(() => action(source)).then((result) => {
      signal?.throwIfAborted();
      return result;
    });
    pending = admitted;
    void admitted.then(() => { pending = undefined; }, () => { pending = undefined; });
    return admitted;
  }

  const view: DocumentReadView = {
    listDocuments: () => read((source) => source.listDocuments()),
    getDocumentMetadata: (id) => read((source) => source.getDocumentMetadata(id)),
    getDocument: (id) => read((source) => source.getDocument(id)),
  };
  signal?.addEventListener("abort", stopAdmission, { once: true });

  try {
    signal?.throwIfAborted();
    return await operation(view);
  } catch (error) {
    hasCallbackFailed = true;
    callbackFailure = error;
    throw error;
  } finally {
    isClosed = true;
    signal?.removeEventListener("abort", stopAdmission);

    try {
      try {
        await pending;
      } catch (error) {
        if (!hasCallbackFailed) {
          throw error;
        }

        if (error !== callbackFailure) {
          throw new AggregateError([callbackFailure, error], "Document read callback and admitted read both failed");
        }
      }

      if (!hasCallbackFailed) {
        signal?.throwIfAborted();
      }
    } finally {
      current = undefined;
      dispose?.();
    }
  }
}
