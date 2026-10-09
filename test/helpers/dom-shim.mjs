/**
 * Minimal document shim covering exactly the DOM surface driver.js touches:
 *
 *   - document.addEventListener("visibilitychange", fn)     (constructor)
 *   - document.removeEventListener("visibilitychange", fn)  (destroy)
 *   - document.visibilityState                              (tick + visibility handler)
 *
 * driver.js references no `window`, no querySelector, and no other DOM API,
 * so the shim deliberately provides nothing else. `hidden` is exposed as a
 * derived getter for parity with the real document.
 */

export function installDomShim() {
  const listeners = []; // { type, listener, options }
  const state = { visibilityState: "visible" };

  const documentShim = {
    get visibilityState() {
      return state.visibilityState;
    },
    get hidden() {
      return state.visibilityState === "hidden";
    },
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener, options) {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index !== -1) listeners.splice(index, 1);
    },
  };

  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: documentShim,
    configurable: true,
    writable: true,
  });

  return {
    /** Registry of installed listeners — safe to assert on. */
    listeners,
    /**
     * Flip visibility like a real tab would: updates visibilityState/hidden
     * and fires the registered "visibilitychange" listeners synchronously.
     */
    setHidden(hidden) {
      state.visibilityState = hidden ? "hidden" : "visible";
      for (const { type, listener } of [...listeners]) {
        if (type === "visibilitychange") listener();
      }
    },
    /** Restore whatever globalThis.document was before installation. */
    remove() {
      if (previous) {
        Object.defineProperty(globalThis, "document", previous);
      } else {
        delete globalThis.document;
      }
    },
  };
}
