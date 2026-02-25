import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the Electron main-process test suite.
 *
 * pool: "forks" — required because the zeromq native module is not safe to
 * load inside Node.js worker_threads (the default "threads" pool). Loading a
 * NAPI addon that manages its own OS threads (zeromq's IO threads) inside a
 * worker thread causes a segfault during worker teardown on Node ≥ 22. Forked
 * child processes each own their own V8 heap and ZMQ context, so teardown is
 * always clean.
 */
export default defineConfig({
  test: {
    pool: "forks",
  },
});
