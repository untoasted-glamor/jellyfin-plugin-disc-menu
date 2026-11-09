// Entry point of DiscMenu/Inject/button.js: the Disc menu button in the web client (see inject.ts). The plugin's
// loader, run by JavaScript Injector, adds this script once a user is signed in.
import { ApiClientLike, DiscMenuButton, serverRootFrom } from "./inject.js";

declare global {
  interface Window {
    ApiClient?: ApiClientLike;
    discMenuButton?: DiscMenuButton;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
const root = script ? serverRootFrom(script.src, location.origin) : null;
// Once per page: the loader runs again if the web client re-runs Injector's scripts.
if (root && !window.discMenuButton) {
  window.discMenuButton = new DiscMenuButton(window, root, () => window.ApiClient);
  window.discMenuButton.start();
}
