package tw.luleopard.baro;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 氣壓高度變化。Android 沒有 iOS 那種「相對高度」API，自己算：
 * 開始量測時的氣壓當 p0，之後每筆換算成相對於 p0 的高度差。
 * 只看短時間內的變化，天氣造成的緩慢漂移由 App 端的滾動基準點吸收。
 * 事件 "change"：{ relAlt: 公尺, pressure: hPa, t: 毫秒 }
 * 很多便宜的手機沒有氣壓計 —— isAvailable 回 false，App 就只靠軌跡判斷。
 */
@CapacitorPlugin(name = "Baro")
public class BaroPlugin extends Plugin implements SensorEventListener {
    private SensorManager sm;
    private Sensor sensor;
    private float p0 = 0f;
    private long lastEmit = 0;

    @Override
    public void load() {
        sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        sensor = sm != null ? sm.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", sensor != null);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSObject r = new JSObject();
        if (sensor == null) { r.put("available", false); call.resolve(r); return; }
        p0 = 0f;
        sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL);
        r.put("available", true);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (sm != null) sm.unregisterListener(this);
        call.resolve();
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float p = e.values[0];                         // hPa
        if (p < 300f || p > 1100f) return;             // 不合理的讀值
        if (p0 == 0f) p0 = p;
        long now = System.currentTimeMillis();
        if (now - lastEmit < 250) return;             // 一秒最多 4 筆，夠用也省電
        lastEmit = now;
        JSObject d = new JSObject();
        d.put("relAlt", SensorManager.getAltitude(p0, p));
        d.put("pressure", p);
        d.put("t", now);
        notifyListeners("change", d);
    }

    @Override
    public void onAccuracyChanged(Sensor s, int a) {}

    @Override
    protected void handleOnDestroy() {
        if (sm != null) sm.unregisterListener(this);
    }
}
