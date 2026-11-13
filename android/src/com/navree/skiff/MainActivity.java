package com.navree.skiff;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.HttpURLConnection;
import java.net.URL;

/** Hosts the Skiff UI (served by skiffd on 127.0.0.1) in a WebView. */
public class MainActivity extends Activity implements Host {
    private static final int REQ_FILES = 7;
    static final int REQ_STORAGE = 8;

    private WebView web;
    private Voice voice;

    // ---- Host ----
    @Override public Voice voice() {
        if (voice == null) voice = new Voice(this, web);
        return voice;
    }
    @Override public android.content.Context context() { return this; }
    @Override public void runOnUi(Runnable r) { runOnUiThread(r); }
    @Override public void reloadWhenReady() { waitForBackend(); }
    @Override public void minimize() { moveTaskToBack(true); }
    @Override public void openApp() {}
    @Override public void setBadge(String kind) {}
    @Override public boolean isBubble() { return false; }
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private boolean loaded;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#111713"));
        w.setNavigationBarColor(Color.parseColor("#111713"));

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0f0c"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        web.addJavascriptInterface(new Bridge(this), "SkiffBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (isOurs(url)) return false;
                openExternal(url);
                return true;
            }

            @Override public void onReceivedError(WebView view, int code, String desc, String url) {
                AppLog.i("webview error " + code + " " + desc + " " + url);
                if (isOurs(url)) {
                    loaded = false;
                    showLoading("Reconnecting to the Skiff backend…");
                    waitForBackend();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) AppLog.i("js: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }

            @Override public void onPermissionRequest(final android.webkit.PermissionRequest req) {
                boolean audio = false;
                for (String r : req.getResources()) if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                if (audio && voice().hasMic()) {
                    req.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    if (audio) voice().requestMic();
                    req.deny();
                }
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                i.setType(types != null && types.length > 0 && types[0].length() > 0 ? types[0] : "*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(i, "Attach"), REQ_FILES);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        askFromIntent(getIntent());
        showLoading("Starting Skiff…");
        SkiffService.start(this);
        waitForBackend();
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        askFromIntent(i);
    }

    private void askFromIntent(Intent i) {
        String[] perms = i != null ? i.getStringArrayExtra("askPermissions") : null;
        if (perms != null) requestPermissions(perms, Voice.REQ_MIC);
    }

    boolean isOurs(String url) {
        return url != null && (url.startsWith("http://127.0.0.1:" + SkiffService.port + "/") || url.startsWith("data:") || url.startsWith("about:"));
    }

    @Override public void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            AppLog.i("cannot open " + url + ": " + e);
        }
    }

    private void showLoading(String msg) {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>"
                + "body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b0f0c;color:#8b9a91;font:15px system-ui}"
                + ".s{width:28px;height:28px;border:3px solid #233029;border-top-color:#3dff8f;border-radius:50%;animation:r .8s linear infinite;margin-bottom:16px}"
                + "@keyframes r{to{transform:rotate(360deg)}}b{color:#e3ece6;font-size:20px;margin-bottom:6px}</style></head>"
                + "<body><div class='s'></div><b>Skiff</b><div>" + msg + "</div></body></html>";
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
    }

    private void showFailure() {
        String log = AppLog.dump();
        if (log.length() > 6000) log = log.substring(log.length() - 6000);
        log = log.replace("&", "&amp;").replace("<", "&lt;");
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>"
                + "body{margin:0;padding:18px;background:#0b0f0c;color:#e3ece6;font:15px system-ui}"
                + "pre{white-space:pre-wrap;font:11px monospace;color:#8b9a91;background:#111713;padding:10px;border-radius:8px}"
                + "button{background:#3dff8f;color:#062611;border:0;border-radius:10px;padding:10px 16px;font-weight:600;margin-right:8px}</style></head><body>"
                + "<h3>Skiff's backend did not start</h3><p>Copy the log below and send it to the developer.</p>"
                + "<button onclick='SkiffBridge.restartServer();location.reload()'>Retry</button>"
                + "<button onclick='SkiffBridge.copyText(document.querySelector(\"pre\").innerText)'>Copy log</button>"
                + "<pre>" + log + "</pre></body></html>";
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
    }

    void waitForBackend() {
        new Thread(new Runnable() {
            @Override public void run() {
                long deadline = System.currentTimeMillis() + 25000;
                while (System.currentTimeMillis() < deadline) {
                    if (SkiffService.port != 0 && healthy()) {
                        ui.post(new Runnable() {
                            @Override public void run() {
                                loaded = true;
                                web.loadUrl("http://127.0.0.1:" + SkiffService.port + "/?t=" + SkiffService.token);
                            }
                        });
                        return;
                    }
                    try { Thread.sleep(300); } catch (InterruptedException ignored) {}
                }
                ui.post(new Runnable() {
                    @Override public void run() { showFailure(); }
                });
            }
        }, "wait-backend").start();
    }

    private boolean healthy() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + SkiffService.port + "/api/health").openConnection();
            c.setConnectTimeout(500);
            c.setReadTimeout(800);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    @Override public void onBackPressed() {
        if (!loaded) {
            moveTaskToBack(true);
            return;
        }
        web.evaluateJavascript("(window.skiffBack && window.skiffBack()) ? 'y' : 'n'", new ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (v == null || !v.contains("y")) moveTaskToBack(true);
            }
        });
    }

    @Override protected void onActivityResult(int req, int result, Intent data) {
        if (req == REQ_FILES && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, result, data);
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        boolean ok = results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (req == Voice.REQ_MIC) web.evaluateJavascript("window.skiffVoice && window.skiffVoice({type:'permission',granted:" + ok + "})", null);
    }

    @Override protected void onDestroy() {
        if (voice != null) voice.destroy();
        super.onDestroy();
    }

    @Override protected void onStart() {
        super.onStart();
        Bubble.appInFront(true);
    }

    @Override protected void onStop() {
        Bubble.appInFront(false);
        super.onStop();
    }

    @Override protected void onResume() {
        super.onResume();
        Bubble.ensure(this); // e.g. just back from granting "display over other apps"
        ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(2);
        if (loaded) web.evaluateJavascript("window.dispatchEvent(new Event('skiff-resume'))", null);
    }
}
