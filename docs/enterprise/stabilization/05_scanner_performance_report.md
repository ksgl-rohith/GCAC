# GCAC Scanner Performance & Caching Stabilization Report

**Report ID**: `05_scanner_performance_report`  
**Platform Measured**: `darwin/arm64` (`Node.js v20.20.0`)  
**Timer Basis**: Monotonic high-resolution clock (`process.hrtime.bigint()`)

---

## 1. Root-Cause Bottlenecks Identified via Instrumentation

Before implementing optimizations, monotonic instrumentation across [`ScanController`](../../../extension/scanning/scanController.js), [`environmentDiscovery.js`](../../../extension/sandbox/environmentDiscovery.js), [`repositoryContext.js`](../../../extension/repositoryContext.js), [`findingsStore.js`](../../../extension/scanning/findingsStore.js), and all four scanner adapters identified six primary bottlenecks:

1. **Repeated Synchronous Subprocess Storms in Environment Discovery (`1662.74 ms` per probe)**: [`findExecutableOnPath`](../../../extension/sandbox/environmentDiscovery.js) invoked `execFileSync('which', ...)` across 12+ candidate binaries sequentially, followed by sequential CLI spawns (`mvn -v`, `java -version`, `dotnet --info`, `git --version`, `docker`). Neither [`getAvailableScanners`](../../../extension/scanning/scanController.js) nor [`startScan`](../../../extension/scanning/scanController.js) shared or cached environment discovery results, causing `getAvailableScanners()` alone to take `2776.01 ms` and three consecutive availability refreshes to take `7988.03 ms`.
2. **Unnecessary Environment Probing for Pure-JS Scans**: Running `secrets-config` alone previously incurred full host SDK/container discovery inside `ScanController`.
3. **Per-File Canonicalization Syscalls & Serial Synchronous Reads**: [`SecretsConfigScanner._collectFiles`](../../../extension/scanning/adapters/secretsConfigScanner.js) called `assertPathWithinAuthorizedRoots` (`fs.realpathSync`) on every file rather than once per directory, then scanned files synchronously on the main event loop.
4. **Blocking CodeQL Subprocess & Full-File Language Detection**: [`CodeQLScanner`](../../../extension/scanning/adapters/codeqlScanner.js) used uncancellable `execFileSync` in `_execCodeql` and read entire source files synchronously in `_detectLanguage`. Repeat `isAvailable()` calls also re-spawned `codeql version --format=json`.
5. **64 KB Buffer Reads on Every File in `discoverProjectManifests`**: [`discoverProjectManifests`](../../../extension/repositoryContext.js) opened and read up to 64 KB of every non-manifest source file solely to check emptiness/whitespace.
6. **Zero Incremental Caching**: Consecutive scans on unchanged repositories re-executed all adapters identically (`2217.15 ms` Scan 1 -> `2185.01 ms` Scan 2 on `payments-api`).

---

## 2. Implemented Optimizations

1. **In-Process PATH Resolution + Host-Global Probe Cache ([`environmentDiscovery.js`](../../../extension/sandbox/environmentDiscovery.js))**:
   - `findExecutableOnPath` scans `process.env.PATH` directly using `fs.statSync` / `fs.accessSync(X_OK)` before optional fallback, removing redundant `which`/`where` subprocess spawns.
   - Added TTL-cached environment discovery (`useCache: true`, 15 s workspace TTL, 30 s host-tool TTL) with explicit `clearEnvironmentCache()` and `forceRefresh` bypass for security/retry re-checks.
2. **Scoped Directory Containment & Bounded-Concurrency File Scanning ([`secretsConfigScanner.js`](../../../extension/scanning/adapters/secretsConfigScanner.js))**:
   - Directory canonicalization checked once per directory while still rejecting symlinks (`entry.isSymbolicLink()`) per entry.
   - Converted scanning to bounded-concurrency (`16`) asynchronous `fs.promises.readFile` with `AbortController` cancellation checks, oversized file skipping (`>2 MB` reported cleanly), monotonic phase timers, and live progress emission.
3. **Async Cancellable CodeQL Subprocesses & 512-Byte Language Detection ([`codeqlScanner.js`](../../../extension/scanning/adapters/codeqlScanner.js))**:
   - Reduced `_detectLanguage` reads to `512` bytes instead of full-file reads.
   - Added cached `isAvailable` binary version resolution with `extensionRoot` support.
   - Implemented `_execCodeqlAsync` using `child_process.spawn` tracked in `this.activeProcess` with `AbortSignal` listener and `SIGTERM` -> `SIGKILL` termination on cancellation or timeout.
4. **Manifest Discovery & Findings Store Caching ([`repositoryContext.js`](../../../extension/repositoryContext.js), [`findingsStore.js`](../../../extension/scanning/findingsStore.js))**:
   - Bounded non-`.csproj` inspection reads in `discoverProjectManifests` to `512` bytes while preserving 64 KB reads for `.csproj` TargetFramework extraction.
   - Added `mtimeMs` + byte-size caching on `FindingsStore.loadFindings()` and `getScanHistory()`.
5. **Key-Bound Incremental Scan Cache ([`scanCache.js`](../../../extension/scanning/scanCache.js))**:
   - Cache key binds `canonicalRepositoryId`, relative target path, sorted SHA-256 input file content digest (`computeInputFingerprint`), `scannerId` + `scannerVersion`, rule/policy config hash, and toolchain context hash.
   - Enforces repository isolation (Repo A never hits for Repo B), invalidates immediately on source changes, enforces advisory freshness TTL for `nuget-audit`, never caches `FAILED`/`CANCELLED`/`TIMED_OUT` results, and tags cache hits explicitly (`fromCache: true`, `freshnessStatus: CACHED_SOURCE_HASH_VERIFIED`).
6. **Quick vs Comprehensive Modes & Honest Progress UI ([`scanController.js`](../../../extension/scanning/scanController.js), [`dashboard.html`](../../../extension/media/dashboard.html), [`dashboard.js`](../../../extension/media/dashboard.js))**:
   - Added explicit `mode: 'quick' | 'comprehensive'` selector. Quick Scan defaults to `secrets-config` only and displays explicit coverage disclosures listing omitted analyzers (`dotnet-security`, `nuget-audit`, `codeql`), never equating Quick Scan to Comprehensive assessment.
   - Replaced synthetic initial `5%` progress width with `.scan-progress-indeterminate` CSS animation when totals are unknown, showing active scanner, current operation, real scanned file count, monotonic elapsed time, cache status, timeout/error reason, and working Cancel Scan termination.

---

## 3. Repeatable Measured Timings (Before vs After)

### Environment & Controller Availability

| Benchmark Metric | Before (ms) | After (ms) | Notes |
| --- | ---: | ---: | --- |
| `discoverEnvironment` (cold uncached) | `1662.74` | `1784.18` | Cold single-host binary probes |
| `getAvailableScanners` (`payments-api`, cold) | `2776.01` | `1701.05` | Single shared env probe across 4 adapters |
| `getAvailableScanners` (3 calls across repos) | `7988.03` | `123.89` | Shared host-probe TTL cache (`64.5x` faster) |

### Repository Scan Timings (`secrets-config`, `dotnet-security`, `nuget-audit`)

Note: Container runtime (`docker` Linux daemon / `podman`) is unavailable on this host (`SANDBOX_UNAVAILABLE`), so `dotnet-security` and `nuget-audit` fail closed in sandbox readiness checks; timings reflect full `ScanController` discovery, fingerprinting, policy gating, secrets/config analysis, normalization, and store persistence.

| Repository & Operation | Before (ms) | After (ms) | Observed Delta / Behavior |
| --- | ---: | ---: | --- |
| `payments-api` (`30` repo files, `9` eligible) — Scan 1 | `2217.15` | `46.66` | Eliminated duplicate env discovery (`47.5x` faster) |
| `payments-api` — Scan 2 (repeat unchanged) | `2185.01` | `29.85` | Hash-verified cache hit on `secrets-config` (`73.2x` faster) |
| `payments-api` — Quick Scan (`secrets-config` only) | N/A | `36.16` | Skips external SDK/container probes |
| `sample-repos` (`83` repo files, `30` eligible) — Scan 1 | `2148.95` | `167.00` | `12.9x` faster; `6` findings |
| `sample-repos` — Scan 2 (repeat unchanged) | N/A | `31.59` | Hash-verified cache hit |
| `synthetic-600` (`1002` total files: `601` src + `401` `node_modules`/`bin`) — `discoverProjectManifests` | `89.29` | `20.73` | Bounded `512 B` read (`4.3x` faster) |
| `synthetic-600` — `SecretsConfigScanner` | `73.09` | `47.37` | `601` non-noise files scanned (`1.54x` faster) |
| `synthetic-600` — `CodeQLScanner._detectLanguage` | `18.89` | `18.74` | `512 B` header read prevents large-file RAM spikes |
| `synthetic-600` — Quick Scan | N/A | `72.51` | Covers `601` files with explicit omitted-scanner banner |
| `synthetic-600` — Scan 1 (3 adapters) | `1266.83` | `228.77` | `5.5x` faster (`discoveryMs: 63.07 ms`) |
| `synthetic-600` — Scan 2 (repeat unchanged) | `1199.03` | `69.26` | `17.3x` faster (`2` cached adapters) |
| `FindingsStore` (40 repeated `loadFindings` + `getScanHistory` reads) | `3.53` | `0.86` | `mtimeMs` + size cache (`4.1x` faster) |

