import Foundation
import Capacitor
import AVFoundation

/**
 * 播報警示時處理其他 App（電台）的聲音，唸完還回去。
 *   request({ mode: "mute" | "duck" })
 *     mute：啟用「不混音」的音訊工作階段 → 其他 App 被中斷（暫停）
 *           iOS 不准背景 App 啟用不混音的工作階段（CannotInterruptOthers），
 *           這時自動退回 duck，至少把電台壓低，不會整句被吃掉
 *     duck：.duckOthers → 其他 App 降低音量
 *   release()：停用工作階段並通知其他 App 可以恢復播放
 *
 * 另外：文字轉語音外掛一啟動就把工作階段設成 duckOthers 並一直開著，
 * 等於整段使用期間電台都被壓低。App 啟動後先呼叫一次 release() 把它放掉。
 */
@objc(AudioFocusPlugin)
public class AudioFocusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioFocusPlugin"
    public let jsName = "AudioFocus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise)
    ]

    private func activate(_ options: AVAudioSession.CategoryOptions) throws {
        let s = AVAudioSession.sharedInstance()
        if #available(iOS 12.0, *) {
            try s.setCategory(.playback, mode: .voicePrompt, options: options)
        } else {
            try s.setCategory(.playback, mode: .spokenAudio, options: options)
        }
        try s.setActive(true)
    }

    @objc func request(_ call: CAPPluginCall) {
        let wantMute = call.getString("mode", "mute") != "duck"
        if wantMute {
            do { try activate([]); call.resolve(["granted": true, "mode": "mute"]); return }
            catch { /* 背景中：退回 duck */ }
        }
        do { try activate([.duckOthers]); call.resolve(["granted": true, "mode": "duck"]) }
        catch { call.resolve(["granted": false, "mode": "none", "error": error.localizedDescription]) }
    }

    @objc func release(_ call: CAPPluginCall) {
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setActive(false, options: .notifyOthersOnDeactivation)
            // 放掉之後改成可混音：之後文字轉語音外掛自己啟用工作階段時，不會再去壓別人
            try s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        } catch { /* 還在唸（工作階段忙）時會失敗，下一次 release 再放 */ }
        call.resolve()
    }
}
