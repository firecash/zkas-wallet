# ZkasEngine: the on-device wallet engine for iOS

`zkas-walletd` as a static library, bound to loopback inside the app, so an iPhone scans
the chain itself instead of trusting a hosted daemon ("Run on this phone" mode).

Two files travel together and are **not committed** (the framework is large):

| File | What |
|---|---|
| `ZkasEngine.xcframework/` | the Rust static library for device (arm64) and simulator (arm64 + x86_64), with UniFFI's C header and modulemap |
| `Sources/zkas_walletd_mobile.swift` | the generated Swift that calls into it; the podspec compiles it into the module `ZkasEngine` that `EmbeddedEnginePlugin.swift` imports |

Install the version named in `ENGINE_VERSION`, then the pods:

```sh
scripts/fetch-ios-engine.sh          # verifies both files against the published MANIFEST
cd ios/App && pod install
```

Published versions: `https://zkas.info/downloads/ios/engine/<version>/`. Each carries a
`MANIFEST` with the `zkas-rusty` and `zkas-signer` revisions it was built from and the
SHA-256 of both files. The engine is built in `zkas-group/zkas-signer`
(`walletd-mobile/README.md`, section "iOS"), on Linux, without Xcode.

Engine API used by the plugin: `start(nodeAddr:walletDir:secret:socks:) -> UInt16`,
`stop()`, `port()`, `logs()`, `setDebugLogs(on:)`, `setMemoryBudgetMb(mb:)`,
`releaseMemory() -> UInt64`, `setFastSync(on:)`, `setChainFilesUrl(url:)`.

Limits on iOS: the engine serves `127.0.0.1` only (no TLS self-hosting), and it runs only
while iOS lets the app run; the plugin stops it cleanly on background and resumes on
foreground. Distribution of the app itself needs an Apple developer account; anyone with
Xcode can build and run it on their own device.
