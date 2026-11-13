package com.navree.skiff;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionSession;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * What the side button opens once Skiff is the digital assistant. The window
 * is a transparent full-screen page (assist.html) that draws one card at the
 * bottom and starts listening. The page tells us which part takes touches:
 * all of it (card and dimmed background), only the small "working" pill
 * while Claude uses the phone, or nothing for the instant Claude taps.
 */
public class AssistSession extends VoiceInteractionSession implements Host {
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static volatile AssistSession current;

    private static final int TOUCH_ALL = 0, TOUCH_REGION = 1, TOUCH_NONE = 2;

    private FrameLayout root;
    private WebView web;
    private Voice voice;
    private boolean loaded;
    private int touch = TOUCH_ALL;
    private final Rect region = new Rect(); // in CSS pixels, from the page
    private boolean acting;
    private final Runnable endAction = new Runnable() {
        @Override public void run() {
            acting = false;
            if (web != null) web.setAlpha(1f);
            refreshInsets();
        }
    };

    AssistSession(Context c) { super(c); }

    /** Called just before Claude taps, types or takes a screenshot. */
    static void collapseForAction() {
        main.post(new Runnable() {
            @Override public void run() {
                AssistSession s = current;
                if (s == null || s.web == null) return;
                s.acting = true;
                s.web.setAlpha(0f);
                s.refreshInsets();
                main.removeCallbacks(s.endAction);
                main.postDelayed(s.endAction, 1200);
            }
        });
    }

    static boolean showing() { return current != null; }

    @Override public void onCreate() {
        super.onCreate();
        try {
            getWindow().getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            getWindow().getWindow().setBackgroundDrawableResource(android.R.color.transparent);
            getWindow().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        } catch (Exception ignored) {}
    }

    @Override public View onCreateContentView() {
        root = new FrameLayout(getContext());
        root.setBackgroundColor(Color.TRANSPARENT);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public android.view.WindowInsets onApplyWindowInsets(View v, android.view.WindowInsets in) {
                int bottom;
                if (Build.VERSION.SDK_INT >= 30) {
                    bottom = Math.max(in.getInsets(android.view.WindowInsets.Type.ime()).bottom,
                            in.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom);
                } else {
                    bottom = in.getSystemWindowInsetBottom();
                }
                if (root.getPaddingBottom() != bottom) root.setPadding(0, 0, 0, bottom);
                return in;
            }
        });
        if (SkiffService.port == 0) {
            TextView t = new TextView(getContext());
            t.setText("Starting Skiff…");
            t.setTextColor(Color.WHITE);
            t.setGravity(Gravity.CENTER);
            root.addView(t, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            try {
                Intent i = new Intent(getContext(), SkiffService.class);
                if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
                else getContext().startService(i);
            } catch (Exception e) {
                AppLog.i("assistant: could not start Skiff: " + e);
            }
            waitForBackend(0);
        } else {
            buildWeb();
        }
        return root;
    }

    private void waitForBackend(final int tries) {
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (root == null) return;
                if (SkiffService.port != 0) { root.removeAllViews(); buildWeb(); }
                else if (tries < 100) waitForBackend(tries + 1);
            }
        }, 200);
    }

    private void buildWeb() {
        web = new WebView(getContext());
        web.setBackgroundColor(Color.TRANSPARENT);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(this), "SkiffBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url.startsWith("http://127.0.0.1:" + SkiffService.port + "/")) return false;
                openExternal(url);
                return true;
            }

            @Override public void onPageFinished(WebView v, String url) { loaded = true; }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(android.webkit.PermissionRequest r) {
                if (voice().hasMic()) r.grant(r.getResources());
                else r.deny();
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // the page starts listening as soon as it loads
        web.loadUrl("http://127.0.0.1:" + SkiffService.port + "/assist.html?t=" + SkiffService.token);
    }

    @Override public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        current = this;
        touch = TOUCH_ALL;
        refreshInsets();
        if (loaded && web != null) web.evaluateJavascript("window.dispatchEvent(new Event('skiff-assist'))", null);
    }

    @Override public void onHide() {
        main.removeCallbacks(endAction);
        endAction.run();
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('skiff-assist-hide'))", null);
        if (voice != null) { voice.cancel(); voice.stopSpeaking(); }
        if (current == this) current = null;
        super.onHide();
    }

    @Override public void onDestroy() {
        if (current == this) current = null;
        main.removeCallbacks(endAction);
        if (voice != null) voice.destroy();
        if (web != null) web.destroy();
        web = null;
        root = null;
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (web == null) { hide(); return; }
        web.evaluateJavascript("(window.skiffBack && window.skiffBack()) ? 'y' : 'n'", new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String v) { if (v == null || !v.contains("y")) hide(); }
        });
    }

    // ---- which part of the screen takes touches ----
    void setTouchAll() {
        main.post(new Runnable() { @Override public void run() { touch = TOUCH_ALL; refreshInsets(); } });
    }

    void setTouchRegion(final int x, final int y, final int w, final int h) {
        main.post(new Runnable() {
            @Override public void run() {
                touch = TOUCH_REGION;
                region.set(x, y, x + w, y + h);
                refreshInsets();
            }
        });
    }

    private void refreshInsets() {
        if (root == null) return;
        root.requestLayout();
        root.invalidate();
    }

    @Override public void onComputeInsets(Insets out) {
        super.onComputeInsets(out);
        if (acting || touch == TOUCH_NONE) {
            out.touchableInsets = Insets.TOUCHABLE_INSETS_REGION;
            out.touchableRegion.setEmpty();
        } else if (touch == TOUCH_REGION && web != null) {
            float d = getContext().getResources().getDisplayMetrics().density;
            int[] at = new int[2];
            web.getLocationInWindow(at);
            out.touchableInsets = Insets.TOUCHABLE_INSETS_REGION;
            out.touchableRegion.set(at[0] + Math.round(region.left * d), at[1] + Math.round(region.top * d),
                    at[0] + Math.round(region.right * d), at[1] + Math.round(region.bottom * d));
        }
    }

    void haptic() {
        main.post(new Runnable() {
            @Override public void run() {
                if (web == null) return;
                web.performHapticFeedback(Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.KEYBOARD_TAP);
            }
        });
    }

    private void startActivitySafely(Intent i) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (Build.VERSION.SDK_INT >= 29) startAssistantActivity(i);
            else getContext().startActivity(i);
        } catch (Exception e) {
            try { getContext().startActivity(i); } catch (Exception ignored) {}
        }
    }

    // ---- Host (used by the bridge inside the assistant page) ----
    @Override public Context context() { return getContext(); }
    @Override public void runOnUi(Runnable r) { main.post(r); }
    @Override public void openExternal(final String url) {
        runOnUi(new Runnable() { @Override public void run() { hide(); startActivitySafely(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } });
    }
    @Override public Voice voice() {
        if (voice == null) voice = new Voice(this, web);
        return voice;
    }
    @Override public void requestPermissions(String[] perms, int code) {
        final Intent i = new Intent(getContext(), MainActivity.class).putExtra("askPermissions", perms);
        runOnUi(new Runnable() { @Override public void run() { hide(); startActivitySafely(i); } });
    }
    @Override public void reloadWhenReady() { if (web != null) web.reload(); }
    @Override public void minimize() { runOnUi(new Runnable() { @Override public void run() { hide(); } }); }
    @Override public void openApp() {
        runOnUi(new Runnable() {
            @Override public void run() {
                hide();
                startActivitySafely(new Intent(getContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP));
            }
        });
    }
    @Override public void setBadge(String kind) {}
    @Override public boolean isBubble() { return true; }
}
