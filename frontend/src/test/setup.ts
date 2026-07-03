// Vitest setup: runs before every test file (see vite.config.ts `test.setupFiles`).
// Clears Tauri IPC mocks and unmounts rendered trees between tests so nothing
// leaks from one test into the next.
//
// NOTE: we deliberately do NOT wire jest-dom matchers. This toolchain bundles
// its own `expect` (the `vitest` package isn't even resolvable), so jest-dom's
// module augmentation can't reach vp's Assertion type. Tests use base matchers
// against real DOM (textContent / contains / getByText's throw-on-miss) instead.

import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vite-plus/test";

afterEach(() => {
  cleanup();
  clearMocks();
});
