// Page elements built from pack data. Pack data (disc names, file names) is text, never markup: it goes in with
// textContent only.
import { DiscInfo } from "./media.js";

/** The label for a disc in the choice of discs. */
export function discLabel(d: DiscInfo): string {
  return d.Season === undefined ? d.Name : `${d.Name} (season ${d.Season})`;
}

/** A button that picks one of an item's discs. */
export function discButton(doc: Document, d: DiscInfo, onPick: () => void): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = discLabel(d);
  b.addEventListener("click", onPick);
  return b;
}
