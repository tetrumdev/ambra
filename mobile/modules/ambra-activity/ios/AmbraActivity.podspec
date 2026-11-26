Pod::Spec.new do |s|
  s.name = 'AmbraActivity'
  s.version = '0.3.0'
  s.summary = 'Ambra Live Activities'
  s.description = 'Starts and updates the downloads Live Activity for the Expo application.'
  s.license = { :type => 'GPL-3.0-only' }
  s.author = 'Ambra contributors'
  s.homepage = 'https://github.com/tetrumdev/ambra'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'ActivityKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
