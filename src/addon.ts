import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { endGridResizeGesture, gridViewSettled } from "./modules/gridView";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;
  // Signals for tests driving the live plugin; adds no user-visible behaviour.
  public readonly testing = {
    /** Resolves once the window's grid view reflects the native item tree. */
    settled: (win: Window): Promise<void> => gridViewSettled(win),
    /**
     * Ends the current resize gesture as if its pause had elapsed. Has no
     * effect while the grid is hidden, which restores its last visible anchor.
     */
    endResizeGesture: (win: Window): void => endGridResizeGesture(win),
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
