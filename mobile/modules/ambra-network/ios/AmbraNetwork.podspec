Pod::Spec.new do |s|
  s.name = 'AmbraNetwork'
  s.version = '0.3.0'
  s.summary = 'Ambra native Rust networking with Tailcat fallback'
  s.description = 'Shares Ambra networking with the Expo application.'
  s.license = { :type => 'GPL-3.0-only' }
  s.author = 'Ambra contributors'
  s.homepage = 'https://github.com/tetrumdev/ambra'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,swift}'
  s.vendored_frameworks = 'AmbraNetwork.xcframework'
  s.frameworks = 'Network', 'CoreFoundation', 'Foundation', 'Security', 'SystemConfiguration'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
