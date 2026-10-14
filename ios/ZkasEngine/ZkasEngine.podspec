# The on-device wallet engine, as a pod the app links.
#
# Two pieces have to travel together: the XCFramework (a static Rust library plus the C
# header and modulemap UniFFI emits) and the generated Swift that calls into it. The
# Swift does `import zkas_walletd_mobileFFI`, which is the module the XCFramework's
# modulemap defines, and this pod compiles it into a module called ZkasEngine — which is
# what EmbeddedEnginePlugin.swift imports.
#
# Both are produced by the `ios-engine` job in firecash/zkas-signer and dropped in here
# by CI before `pod install`. They are not committed: the XCFramework is ~300 MB.
Pod::Spec.new do |s|
  s.name             = 'ZkasEngine'
  s.module_name      = 'ZkasEngine'
  s.version          = '0.1.0'
  s.summary          = 'ZKas on-device wallet engine (zkas-walletd) for iOS.'
  s.description      = 'Runs the ZKas wallet daemon in-process on iOS, bound to loopback, so the wallet scans the chain on the phone instead of trusting a hosted daemon.'
  s.homepage         = 'https://zkas.info'
  s.license          = { :type => 'MIT' }
  s.author           = 'ZKas'
  s.source           = { :http => 'https://zkas.info' }
  s.ios.deployment_target = '13.0'
  s.swift_version    = '5.9'
  s.source_files     = 'Sources/**/*.swift'
  s.vendored_frameworks = 'ZkasEngine.xcframework'
  # The Rust static library pulls in the system libraries it links against.
  s.libraries        = 'resolv', 'c++'
  s.frameworks       = 'Security', 'SystemConfiguration'
end
