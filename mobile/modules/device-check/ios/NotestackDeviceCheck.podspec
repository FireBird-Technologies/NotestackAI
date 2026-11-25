Pod::Spec.new do |s|
  s.name           = 'NotestackDeviceCheck'
  s.version        = '1.0.0'
  s.summary        = 'Apple DeviceCheck for guest mode'
  s.description    = 'Apple DeviceCheck for guest mode'
  s.license        = 'UNLICENSED'
  s.author         = 'Notestack'
  s.homepage       = 'https://notestack.ai'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'DeviceCheck'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
