require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'LuleopardBaro'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'Proprietary'
  s.homepage = 'https://github.com/winnerich168/luleopard'
  s.author = 'winnerich168'
  s.source = { :git => 'https://github.com/winnerich168/luleopard.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.frameworks = 'CoreMotion'
  s.swift_version = '5.1'
end
