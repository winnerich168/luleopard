import Foundation
import Capacitor
import CoreMotion

/**
 * 氣壓高度變化。CMAltimeter 的 relativeAltitude 本來就是「相對於開始量測那一刻」的高度差，
 * 正好是我們要的：不看絕對高度（天氣一變就差好幾公尺），只看短時間內上升或下降多少。
 * 事件 "change"：{ relAlt: 公尺, pressure: hPa, t: 毫秒 }
 */
@objc(BaroPlugin)
public class BaroPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BaroPlugin"
    public let jsName = "Baro"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private var altimeter: CMAltimeter?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": CMAltimeter.isRelativeAltitudeAvailable()])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard CMAltimeter.isRelativeAltitudeAvailable() else {
            call.resolve(["available": false]); return
        }
        if altimeter == nil { altimeter = CMAltimeter() }
        altimeter?.startRelativeAltitudeUpdates(to: OperationQueue.main) { [weak self] data, error in
            guard let d = data, error == nil else { return }
            self?.notifyListeners("change", data: [
                "relAlt": d.relativeAltitude.doubleValue,
                "pressure": d.pressure.doubleValue * 10.0,          // kPa → hPa
                "t": Date().timeIntervalSince1970 * 1000.0
            ])
        }
        call.resolve(["available": true])
    }

    @objc func stop(_ call: CAPPluginCall) {
        altimeter?.stopRelativeAltitudeUpdates()
        call.resolve()
    }
}
