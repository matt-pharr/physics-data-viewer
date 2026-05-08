import { defineConfig, configDefaults } from "vitest/config";

/**
 * Vitest configuration for the Electron main-process test suite.
 *
 * pool: "forks" — required because the zeromq native module is not safe to
 * load inside Node.js worker_threads (the default "threads" pool). Loading a
 * NAPI addon that manages its own OS threads (zeromq's IO threads) inside a
 * worker thread causes a segfault during worker teardown on Node ≥ 22. Forked
 * child processes each own their own V8 heap and ZMQ context, so teardown is
 * always clean.
 *
 * @slow tests (real Python kernel + comm traffic) are excluded by default so
 * `npm test` runs fast and doesn't require a Python toolchain. They opt in
 * when PYTHON_PATH is set in the environment — CI's node-main-tests job sets
 * this explicitly, and local devs can do the same once they have a Python
 * env with `pdv-python[dev]` installed.
 */
const runSlow = !!process.env.PYTHON_PATH;

const slowFiles = [
  "main/integration.test.ts",
  "main/kernel-manager.test.ts",
  "main/kernel-manager-errors.test.ts",
];

export default defineConfig({
  test: {
    pool: "forks",
    exclude: [
      ...configDefaults.exclude,
      // Playwright specs live under ./e2e and are not vitest tests.
      "e2e/**",
      ...(runSlow ? [] : slowFiles),
    ],
  },
});
