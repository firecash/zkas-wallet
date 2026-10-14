import Capacitor
import Foundation
import UIKit
import ZkasEngine

/**
 Runs the ZKas wallet engine (zkas-walletd) NATIVELY, in this app's process, bound to a
 loopback port — "Run on this phone" mode. The WebView then talks to
 http://127.0.0.1:<port>. The seed and full viewing key never leave the device: the
 engine pulls compact block records from a public node's gRPC and trial-decrypts locally.

 This mirrors the Android plugin method for method, so the TypeScript in src/embedded.ts
 needs no platform branch. Where iOS has no equivalent of an Android facility the method
 still exists and degrades honestly rather than being absent — a missing method throws
 "not implemented" through the bridge and the caller cannot tell that from a failure.

 Two places where iOS genuinely differs, and the difference is reported rather than faked:

 - `keepAlive` has nothing to hold. Android keeps a `dataSync` foreground service alive so
   the process survives the screen going dark. iOS has no such thing: an app is suspended
   shortly after it leaves the foreground, and background work is limited to short
   `BGProcessingTask` windows the system schedules at its discretion. A sync therefore
   progresses while the app is open and is suspended when it is not. It resumes from its
   last checkpoint, so nothing is lost — it simply does not advance in the background the
   way it does on Android.

 - `lastExit` has no source. `ApplicationExitInfo` is an Android API; iOS keeps no
   equivalent record an app can read. It reports `available: false` so the log a user
   sends says so, instead of implying the app has never died.
 */
@objc(EmbeddedEnginePlugin)
public class EmbeddedEnginePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EmbeddedEnginePlugin"
    public let jsName = "EmbeddedEngine"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDebugLogs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lastExit", returnType: CAPPluginReturnPromise),
    ]

    /// The public node's gRPC — the same default the Android and desktop shells use.
    private static let defaultNode = "seed.zkas.info:16110"

    /// Where the engine keeps its wallet files and scan checkpoints.
    ///
    /// Application Support rather than Documents: Documents is surfaced in the Files app
    /// and offered to iCloud, and a scan checkpoint is a rebuildable cache that can reach
    /// hundreds of MB — it has no business in a user's backup. Excluded from backup for
    /// the same reason. The seed is NOT here; it lives where the app keeps it, and this
    /// directory holds only what the engine can rebuild from the chain.
    private func walletDir() throws -> String {
        let fm = FileManager.default
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                              appropriateFor: nil, create: true)
        var dir = base.appendingPathComponent("wallets", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        try? dir.setResourceValues(excluded)
        return dir.path
    }

    /// Start the engine against `nodeAddr` (host:port gRPC); resolves with the loopback port.
    @objc func start(_ call: CAPPluginCall) {
        let node = call.getString("nodeAddr") ?? Self.defaultNode
        let secret = call.getString("secret")
        let socks = call.getString("socks")
        // Off the main thread: starting the engine opens the wallet store and binds a
        // port, which is not instant and must not block the UI.
        DispatchQueue.global(qos: .userInitiated).async {
            // The engine cannot see this app's memory ceiling, and the device-wide figure
            // it would otherwise use is far larger than what this process may hold.
            self.reportMemoryBudget()
            let dir: String
            do { dir = try self.walletDir() } catch {
                call.reject("Could not create the wallet directory: \(error.localizedDescription)")
                return
            }
            let port = Int(ZkasEngine.start(nodeAddr: node, walletDir: dir, secret: secret, socks: socks))
            if port == 0 {
                call.reject("The on-device wallet engine could not start.")
            } else {
                call.resolve(["port": port])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            ZkasEngine.stop()
            call.resolve()
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        let port = Int(ZkasEngine.port())
        call.resolve(["port": port, "running": port != 0])
    }

    @objc func logs(_ call: CAPPluginCall) {
        call.resolve(["text": ZkasEngine.logs()])
    }

    @objc func setDebugLogs(_ call: CAPPluginCall) {
        ZkasEngine.setDebugLogs(on: call.getBool("on") ?? false)
        call.resolve()
    }

    /**
     Android holds a foreground service here. iOS cannot: there is no API that keeps a
     suspended app running to finish a download-like task of unbounded length.

     Resolving (rather than rejecting) is deliberate — the app calls this from its status
     poll on every platform, and a rejection would surface as a recurring error for
     something that is working as well as iOS permits.
     */
    @objc func keepAlive(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? true
        // The one thing that genuinely helps: while a sync is in flight and the app is
        // open, ask iOS not to idle-time the screen off, so a user watching it finish is
        // not interrupted. Released as soon as the wallet reports synced.
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
        }
        call.resolve(["held": false, "reason": on ? "ios-has-no-foreground-service" : "released"])
    }

    /// No iOS equivalent of ApplicationExitInfo exists, so say that plainly.
    @objc func lastExit(_ call: CAPPluginCall) {
        call.resolve(["available": false, "error": "ios-has-no-exit-reason-api"])
    }

    /// Hand the engine this app's memory ceiling, in MB.
    ///
    /// The engine otherwise sizes its resident-wallet cache from system-wide free memory,
    /// which on a phone is far more than one app may hold. iOS does not publish a hard
    /// per-app cap the way Android's memory class does, so this uses what it does publish:
    /// `os_proc_available_memory` is the headroom this process has left before the system
    /// kills it, which is the figure that actually matters.
    private func reportMemoryBudget() {
        var mb: UInt32 = 0
        if #available(iOS 13.0, *) {
            let avail = os_proc_available_memory()
            if avail > 0 { mb = UInt32(min(avail / (1024 * 1024), Int(UInt32.max))) }
        }
        if mb == 0 {
            // Fall back to total physical memory, which over-states what we may use, so
            // take a conservative slice of it rather than the whole figure.
            mb = UInt32(min(ProcessInfo.processInfo.physicalMemory / (1024 * 1024) / 4, UInt64(UInt32.max)))
        }
        if mb > 0 { ZkasEngine.setMemoryBudgetMb(mb: mb) }
    }
}
