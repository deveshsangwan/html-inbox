export function renderDiagram(element) {
  if (element.textContent.trim() !== "graph TD; Stored-->Rendered;") {
    throw new Error("Unexpected Mermaid fixture diagram");
  }

  element.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" role="img" width="200" height="40"><text x="0" y="20">Stored</text><text x="100" y="20">Rendered</text></svg>';
}
