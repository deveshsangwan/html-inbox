import { renderDiagram } from "./chunks/fixture-render.mjs";

export default {
  initialize(options) {
    if (options.startOnLoad !== false || options.securityLevel !== "strict") {
      throw new Error("Unexpected Mermaid initialization options");
    }
  },

  async run({ querySelector }) {
    for (const element of document.querySelectorAll(querySelector)) {
      renderDiagram(element);
    }
  },
};
