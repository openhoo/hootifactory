import { setDefaultTimeout } from "bun:test";

// CI runners have 2 vCPUs, but `bun run test:unit` runs ~60 workspace packages
// concurrently and each spawns isolate test-worker processes (`bun test
// --parallel`). Under that oversubscription a heavy first-in-file test can take
// several seconds of wall-clock purely from CPU starvation and trip Bun's 5s
// default per-test timeout (it completes fine given CPU). Give tests headroom so
// the suite is deterministic regardless of runner core count.
setDefaultTimeout(30_000);
