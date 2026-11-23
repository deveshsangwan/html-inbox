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

  function read<Result>(action: (source: DocumentReadView) => Promise<Result>): Promise<Result> {
    if (isClosed || !current) {
      return Promise.reject(new Error("Document read view is closed"));
    }

    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    if (pending) {
      return Promise.reject(new Error("Document read view already has an active read"));
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

  try {
    signal?.throwIfAborted();
    return await operation(view);
  } catch (error) {
    hasCallbackFailed = true;
    callbackFailure = error;
    throw error;
  } finally {
    isClosed = true;

    try {
      try {
        await pending;
      } catch (error) {
        if (!hasCallbackFailed) {
          throw error;
        }

        // Object.is treats a repeated NaN abort reason as the same failure.
        if (!Object.is(error, callbackFailure)) {
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
