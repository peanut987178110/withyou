package app.withyou.demo;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * WithYou 原生壳入口。
 *
 * 后端（FastAPI）由 Chaquopy 打包进 APK，App 启动时在本机 127.0.0.1:8765 上跑起来，
 * 所以装到手机上**不依赖电脑、不依赖网络**，飞行模式也能用。
 *
 * 时序很关键：页面的 JS 一加载就会请求 /api/v1/meta。如果后端还没起来，
 * 首屏会直接变成 "Couldn't open WithYou"。因此这里先让 WebView 停在空白页，
 * 等 withyou_boot.wait_ready() 确认 /healthz 能应答，再加载真正的界面。
 *
 * 调试：
 *   adb logcat -s WithYou
 *   adb shell am start -n app.withyou.demo/.MainActivity
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "WithYou";
    private static final String LOCAL_URL = "http://localhost/";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 先把 WebView 摁在空白页，避免它在后端就绪前发出 /meta 请求。
        WebView early = getBridge() == null ? null : getBridge().getWebView();
        if (early != null) early.loadUrl("about:blank");
        startPythonBackend();
    }

    /** 在后台线程把内置后端拉起来，不阻塞 UI。 */
    private void startPythonBackend() {
        new Thread(() -> {
            try {
                if (!Python.isStarted()) {
                    Python.start(new AndroidPlatform(getApplicationContext()));
                }
                PyObject boot = Python.getInstance().getModule("withyou_boot");
                PyObject info = boot.callAttr("start", getFilesDir().getAbsolutePath());
                Log.i(TAG, "python backend: " + info);
                if (boot.callAttr("wait_ready", 45).toBoolean()) {
                    Log.i(TAG, "backend ready — loading app");
                    loadApp();
                } else {
                    Log.e(TAG, "backend did not become ready in time: " + info);
                    loadApp();  // 仍然放行：界面会显示可点的重试按钮，总比永远白屏好
                }
            } catch (Exception e) {
                Log.e(TAG, "python backend failed", e);
                loadApp();
            }
        }, "wy-python-boot").start();
    }

    /** 后端就绪后再把 WebView 指到真正的界面（主线程）。 */
    private void loadApp() {
        runOnUiThread(() -> {
            Bridge bridge = getBridge();
            if (bridge == null || bridge.getWebView() == null) return;
            WebView wv = bridge.getWebView();
            String url;
            try {
                url = bridge.getServerUrl();
                if (url == null || url.isEmpty()) url = LOCAL_URL;
            } catch (Throwable t) {
                url = LOCAL_URL;
            }
            wv.loadUrl(url);
        });
    }

    @Override
    public void onStart() {
        super.onStart();
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) return;

        // WebView 默认白底：系统启动画面退场后、页面首帧绘出来之前会露一帧白。
        // 设成品牌纸色 --paper，和页面背景连成一色，冷启动不再闪白。
        bridge.getWebView().setBackgroundColor(0xFFFBFAFC);

        WebSettings s = bridge.getWebView().getSettings();
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 输入框字号 < 16px 时 Android WebView 会强制放大页面；CSS 里的 15px
        // 会被这一条顶掉，所以关掉自动缩放，保持设计稿的字号。
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
    }
}