package tw.luleopard.audio;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 播報警示時跟系統要音訊焦點，唸完還回去。
 *   request({ mode: "mute" | "duck" })
 *     mute：AUDIOFOCUS_GAIN_TRANSIENT —— 其他 App（電台）收到「暫時失去焦點」會暫停，還回去後自己恢復
 *     duck：AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK —— 其他 App 只降低音量
 *   release()
 * 用途標成「導航語音」：系統與車機都知道這是行車提示。
 */
@CapacitorPlugin(name = "AudioFocus")
public class AudioFocusPlugin extends Plugin {
    private AudioManager am;
    private AudioFocusRequest req;                       // API 26 以上
    private final AudioManager.OnAudioFocusChangeListener listener = change -> {};

    @Override
    public void load() {
        am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void request(PluginCall call) {
        JSObject r = new JSObject();
        if (am == null) { r.put("granted", false); call.resolve(r); return; }
        boolean duck = "duck".equals(call.getString("mode", "mute"));
        int gain = duck ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
        abandon();
        int res;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            req = new AudioFocusRequest.Builder(gain)
                .setAudioAttributes(aa)
                .setOnAudioFocusChangeListener(listener)
                .build();
            res = am.requestAudioFocus(req);
        } else {
            res = am.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, gain);
        }
        r.put("granted", res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        r.put("mode", duck ? "duck" : "mute");
        call.resolve(r);
    }

    @PluginMethod
    public void release(PluginCall call) {
        abandon();
        call.resolve();
    }

    private void abandon() {
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (req != null) { am.abandonAudioFocusRequest(req); req = null; }
        } else {
            am.abandonAudioFocus(listener);
        }
    }

    @Override
    protected void handleOnDestroy() { abandon(); }
}
