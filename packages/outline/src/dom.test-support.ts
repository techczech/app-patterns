import { JSDOM } from "jsdom";

export function installDom(): () => void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const legacyInputPrototype = dom.window.HTMLElement.prototype as typeof dom.window.HTMLElement.prototype & {
    attachEvent: () => void;
    detachEvent: () => void;
  };
  legacyInputPrototype.attachEvent = () => {};
  legacyInputPrototype.detachEvent = () => {};
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    FormData: dom.window.FormData,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  });
  return () => {
    dom.window.close();
    Object.assign(globalThis, previous);
  };
}
