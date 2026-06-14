import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount any rendered trees between tests so happy-dom state never leaks.
afterEach(() => {
  cleanup();
});
