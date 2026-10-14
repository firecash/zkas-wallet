import Capacitor
import Foundation
import Security

/**
 A durable, device-only Keychain mirror for the few values the wallet cannot afford to
 lose.

 WHY THIS EXISTS. Every piece of wallet state — including `device_seed_<token>` and the
 `device_mnemonic` recovery phrase, or their sealed forms when the app lock is on — lives
 in the WebView's localStorage. On Android that is app data and survives until the app is
 uninstalled. On iOS it is WebKit website data, which the system is free to evict when
 storage runs low. If it goes with the app lock off, the only copy of the seed goes with
 it; with the lock on, the sealed blob goes and the Keychain unlock secret is left with
 nothing to open. Either way the coins are unreachable unless the user wrote the phrase
 down.

 WHAT THIS IS NOT. It does not replace localStorage, and nothing here changes which store
 is authoritative. The wallet keeps reading and writing exactly as it does on every other
 platform; this is a write-through copy plus a restore path, so a purge becomes a recovered
 wallet instead of a lost one. That matters because the seed paths in this app have a
 history of subtle breakage, and a safety net that alters the live path is not a safety net.

 ACCESSIBILITY. `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by background
 work after the first unlock following a boot, never synced to iCloud, and not migrated to
 another device by a backup. A seed is device-bound by design; putting it in the iCloud
 keychain would quietly turn a local secret into a cloud-hosted one, which is the opposite
 of what a non-custodial wallet promises.
 */
@objc(SecureStorePlugin)
public class SecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStorePlugin"
    public let jsName = "SecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keys", returnType: CAPPluginReturnPromise),
    ]

    /// One service name, so `keys` can enumerate what the mirror holds without touching
    /// anything else this app or its plugins keep in the Keychain (the app lock's
    /// credentials live under their own service).
    private static let service = "info.zkas.wallet.securestore"

    private func query(_ key: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
        ]
        if let key { q[kSecAttrAccount as String] = key }
        return q
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }
        var attrs = query(key)
        // Replace rather than add-or-fail: SecItemAdd returns errSecDuplicateItem for an
        // existing account, and a silent failure here is the whole problem this guards.
        SecItemDelete(attrs as CFDictionary)
        attrs[kSecValueData as String] = Data(value.utf8)
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attrs as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("keychain write failed (OSStatus \(status))")
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8) {
            call.resolve(["value": s])
        } else {
            // Absent is not an error: the caller asks for anything that might be there.
            call.resolve(["value": NSNull()])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        SecItemDelete(query(key) as CFDictionary)
        call.resolve()
    }

    /// Everything the mirror holds, so a restore can find wallets whose tokens the app
    /// no longer knows about — which is exactly the case after a localStorage purge.
    @objc func keys(_ call: CAPPluginCall) {
        var q = query()
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess, let items = out as? [[String: Any]] else {
            call.resolve(["keys": [String]()])
            return
        }
        let keys = items.compactMap { $0[kSecAttrAccount as String] as? String }
        call.resolve(["keys": keys])
    }
}
