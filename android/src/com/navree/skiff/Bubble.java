package com.navree.skiff;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

/**
 * The floating chat bubble: a draggable icon over every app. Tapping it opens
 * a compact chat (the same conversation as the app's Chat tab). When Claude
 * acts on the phone the panel tucks away so the app underneath is free.
 */
public class Bubble implements Host {
    private static Bubble instance;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private final Context ctx;
    private final WindowManager wm;
    private final int type;
    private static final int SIZE_DP = 72; // disc + ring + room for the glow
    private RingView bubble;
    private View dot;
    private WindowManager.LayoutParams blp;
    private FrameLayout panel; // full-screen, transparent window
    private FrameLayout sheet; // the chat itself, at the bottom
    private WindowManager.LayoutParams plp;
    private WebView web;
    private View trash;
    private boolean expanded;
    private Voice voice;
    private final Runnable restore = new Runnable() { @Override public void run() { setBubbleVisible(true); } };

    static android.content.SharedPreferences prefs(Context c) { return c.getSharedPreferences("skiff", Context.MODE_PRIVATE); }

    static boolean enabled(Context c) { return prefs(c).getBoolean("bubble", false); }

    static void setEnabled(Context c, boolean on) {
        prefs(c).edit().putBoolean("bubble", on).apply();
        if (on) ensure(c);
        else stop();
    }

    /** Starts the bubble if it is enabled and we can draw over other apps. */
    static void ensure(final Context any) {
        main.post(new Runnable() {
            @Override public void run() {
                if (instance != null || !enabled(any) || SkiffService.port == 0) return;
                Context c;
                int t;
                if (Settings.canDrawOverlays(any)) {
                    c = any.getApplicationContext();
                    t = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
                } else if (SkiffHands.get() != null) {
                    // phone control is on: draw through the accessibility service
                    c = SkiffHands.get();
                    t = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY;
                } else {
                    AppLog.i("bubble: needs 'display over other apps' or phone control");
                    return;
                }
                try {
                    instance = new Bubble(c, t);
                    instance.show();
                } catch (Exception e) {
                    AppLog.i("bubble failed: " + e);
                    instance = null;
                }
            }
        });
    }

    static void stop() {
        main.post(new Runnable() {
            @Override public void run() {
                if (instance == null) return;
                instance.destroy();
                instance = null;
            }
        });
    }

    static boolean running() { return instance != null; }

    /** The ring turns while Claude is working. */
    static void setBusy(final boolean busy) {
        main.post(new Runnable() {
            @Override public void run() { if (instance != null && instance.bubble != null) instance.bubble.setBusy(busy); }
        });
    }

    // Like chat heads: the bubble steps aside while Skiff itself is open.
    private static boolean appFront;

    static void appInFront(final boolean front) {
        main.post(new Runnable() {
            @Override public void run() {
                appFront = front;
                if (instance == null) return;
                if (front) instance.collapse();
                instance.setBubbleVisible(true);
            }
        });
    }

    /** Called before Claude acts on the screen: get out of the way for a moment. */
    static void collapseForAction() {
        main.post(new Runnable() {
            @Override public void run() {
                if (instance == null) return;
                instance.collapse();
                instance.setBubbleVisible(false);
                main.removeCallbacks(instance.restore);
                main.postDelayed(instance.restore, 3500);
            }
        });
    }

    private Bubble(Context ctx, int type) {
        this.ctx = ctx;
        this.type = type;
        this.wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
    }

    private int dp(float v) { return Math.round(v * ctx.getResources().getDisplayMetrics().density); }

    private DisplayMetrics screen() {
        DisplayMetrics m = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(m);
        return m;
    }

    private void show() {
        final int size = dp(SIZE_DP);
        bubble = new RingView(ctx);
        ImageView icon = new ImageView(ctx);
        icon.setImageResource(R.mipmap.ic_launcher);
        icon.setOutlineProvider(new android.view.ViewOutlineProvider() {
            @Override public void getOutline(View v, android.graphics.Outline o) { o.setOval(0, 0, v.getWidth(), v.getHeight()); }
        });
        icon.setClipToOutline(true);
        bubble.addView(icon, new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER));
        dot = new View(ctx);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(Color.parseColor("#ffcc66"));
        d.setStroke(dp(2), Color.parseColor("#111713"));
        dot.setBackground(d);
        dot.setVisibility(View.GONE);
        FrameLayout.LayoutParams dlp = new FrameLayout.LayoutParams(dp(16), dp(16), Gravity.TOP | Gravity.END);
        dlp.topMargin = dp(9); // sits on the ring, top right
        dlp.rightMargin = dp(9);
        bubble.addView(dot, dlp);

        blp = new WindowManager.LayoutParams(size, size, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        blp.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics m = screen();
        blp.x = prefs(ctx).getInt("bubbleX", m.widthPixels - size - dp(8));
        blp.y = prefs(ctx).getInt("bubbleY", m.heightPixels * 2 / 5);
        bubble.setOnTouchListener(new Drag());
        wm.addView(bubble, blp);
        setBubbleVisible(true);
        // The chat page loads now, hidden, so it is connected and can raise
        // the badge (or open itself for a question) before the first tap.
        buildPanel();
    }

    private class Drag implements View.OnTouchListener {
        private float sx, sy;
        private int ox, oy;
        private boolean dragging;
        private final int slop = ViewConfiguration.get(ctx).getScaledTouchSlop();

        @Override public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    sx = e.getRawX(); sy = e.getRawY(); ox = blp.x; oy = blp.y; dragging = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - sx, dy = e.getRawY() - sy;
                    if (!dragging && Math.hypot(dx, dy) > slop) { dragging = true; showTrash(true); }
                    if (dragging) {
                        blp.x = ox + Math.round(dx);
                        blp.y = oy + Math.round(dy);
                        try { wm.updateViewLayout(bubble, blp); } catch (Exception ignored) {}
                        highlightTrash(overTrash(e));
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (!dragging) { toggle(); return true; }
                    boolean drop = overTrash(e);
                    showTrash(false);
                    if (drop) {
                        Bubble.setEnabled(ctx, false);
                        android.widget.Toast.makeText(ctx, "Chat bubble hidden. Turn it on again in Skiff → Setup.", android.widget.Toast.LENGTH_LONG).show();
                        return true;
                    }
                    snap();
                    return true;
            }
            return false;
        }
    }

    private boolean overTrash(MotionEvent e) {
        DisplayMetrics m = screen();
        return Math.abs(e.getRawX() - m.widthPixels / 2f) < dp(60) && e.getRawY() > m.heightPixels - dp(170);
    }

    private void showTrash(boolean on) {
        if (on && trash == null) {
            TextView t = new TextView(ctx);
            t.setText("✕");
            t.setTextSize(22);
            t.setTextColor(Color.WHITE);
            t.setGravity(Gravity.CENTER);
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(Color.parseColor("#CC1b2420"));
            g.setStroke(dp(2), Color.parseColor("#8b9a91"));
            t.setBackground(g);
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(dp(64), dp(64), type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE, PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(70);
            trash = t;
            try { wm.addView(trash, lp); } catch (Exception e) { trash = null; }
        } else if (!on && trash != null) {
            try { wm.removeView(trash); } catch (Exception ignored) {}
            trash = null;
        }
    }

    private void highlightTrash(boolean over) {
        if (trash != null) trash.setScaleX(over ? 1.25f : 1f);
        if (trash != null) trash.setScaleY(over ? 1.25f : 1f);
    }

    private void snap() {
        DisplayMetrics m = screen();
        final int size = dp(SIZE_DP);
        int target = blp.x + size / 2 < m.widthPixels / 2 ? dp(8) : m.widthPixels - size - dp(8);
        blp.y = Math.max(dp(40), Math.min(blp.y, m.heightPixels - size - dp(80)));
        ValueAnimator va = ValueAnimator.ofInt(blp.x, target);
        va.setDuration(180);
        va.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override public void onAnimationUpdate(ValueAnimator a) {
                blp.x = (Integer) a.getAnimatedValue();
                try { wm.updateViewLayout(bubble, blp); } catch (Exception ignored) {}
            }
        });
        va.start();
        prefs(ctx).edit().putInt("bubbleX", target).putInt("bubbleY", blp.y).apply();
    }

    private void setBubbleVisible(boolean on) {
        if (bubble == null) return;
        on = on && !appFront;
        bubble.setVisibility(on && !expanded ? View.VISIBLE : View.GONE);
        blp.flags = on ? (blp.flags & ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) : (blp.flags | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        try { wm.updateViewLayout(bubble, blp); } catch (Exception ignored) {}
    }

    private void toggle() {
        if (expanded) collapse();
        else expand();
    }

    private void expand() {
        if (panel == null) buildPanel();
        expanded = true;
        dot.setVisibility(View.GONE);
        panel.setVisibility(View.VISIBLE);
        plp.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
        try { wm.updateViewLayout(panel, plp); } catch (Exception ignored) {}
        setBubbleVisible(false);
        web.evaluateJavascript("window.dispatchEvent(new Event('skiff-resume'))", null);
    }

    private void collapse() {
        if (panel == null || !expanded) return;
        expanded = false;
        panel.setVisibility(View.GONE);
        plp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        try { wm.updateViewLayout(panel, plp); } catch (Exception ignored) {}
        setBubbleVisible(true);
    }

    private void buildPanel() {
        final DisplayMetrics m = screen();
        // The window covers the whole screen (transparent) and the chat is a
        // sheet at its bottom. When the keyboard opens, Android shrinks the
        // window (or reports the keyboard as an inset): the sheet then gets
        // shorter so the message box stays just above the keyboard.
        panel = new FrameLayout(ctx) {
            @Override public boolean dispatchKeyEvent(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && e.getAction() == KeyEvent.ACTION_UP) {
                    web.evaluateJavascript("(window.skiffBack && window.skiffBack()) ? 'y' : 'n'", new android.webkit.ValueCallback<String>() {
                        @Override public void onReceiveValue(String v) { if (v == null || !v.contains("y")) collapse(); }
                    });
                    return true;
                }
                return super.dispatchKeyEvent(e);
            }

            @Override protected void onMeasure(int w, int h) {
                int avail = MeasureSpec.getSize(h) - getPaddingTop() - getPaddingBottom();
                int want = Math.max(dp(220), Math.min(Math.round(m.heightPixels * 0.72f), avail - dp(12)));
                FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sheet.getLayoutParams();
                if (lp.height != want) lp.height = want;
                super.onMeasure(w, h);
            }

            // a tap on the empty area above the sheet puts the chat away
            @Override public boolean onTouchEvent(MotionEvent e) {
                int a = e.getActionMasked();
                if (a == MotionEvent.ACTION_OUTSIDE || a == MotionEvent.ACTION_DOWN) { collapse(); return true; }
                return super.onTouchEvent(e);
            }
        };
        panel.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public android.view.WindowInsets onApplyWindowInsets(View v, android.view.WindowInsets in) {
                int bottom = 0;
                if (Build.VERSION.SDK_INT >= 30) {
                    bottom = Math.max(in.getInsets(android.view.WindowInsets.Type.ime()).bottom,
                            in.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom);
                } else {
                    bottom = in.getSystemWindowInsetBottom();
                }
                if (panel.getPaddingBottom() != bottom) panel.setPadding(0, 0, 0, bottom);
                return in;
            }
        });
        panel.setBackgroundColor(Color.parseColor("#33000000")); // a light scrim over the app behind
        sheet = new FrameLayout(ctx);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#0b0f0c"));
        bg.setCornerRadii(new float[]{dp(22), dp(22), dp(22), dp(22), 0, 0, 0, 0});
        bg.setStroke(dp(1), Color.parseColor("#233029"));
        sheet.setBackground(bg);
        sheet.setClipToOutline(true);
        sheet.setElevation(dp(12));
        sheet.setClickable(true); // touches inside the sheet never reach the "outside" handler
        web = new WebView(ctx);
        web.setBackgroundColor(Color.parseColor("#0b0f0c"));
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
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(android.webkit.PermissionRequest r) {
                if (voice().hasMic()) r.grant(r.getResources());
                else r.deny();
            }
        });
        sheet.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        panel.addView(sheet, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, Math.round(m.heightPixels * 0.72f), Gravity.BOTTOM));
        plp = new WindowManager.LayoutParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                PixelFormat.TRANSLUCENT);
        panel.setVisibility(View.GONE);
        plp.gravity = Gravity.BOTTOM;
        plp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        wm.addView(panel, plp);
        web.loadUrl("http://127.0.0.1:" + SkiffService.port + "/?mini=1&t=" + SkiffService.token);
    }

    private void destroy() {
        main.removeCallbacks(restore);
        showTrash(false);
        try { if (bubble != null) wm.removeView(bubble); } catch (Exception ignored) {}
        try { if (panel != null) wm.removeView(panel); } catch (Exception ignored) {}
        if (web != null) web.destroy();
        if (voice != null) voice.destroy();
        bubble = null;
        panel = null;
        sheet = null;
        web = null;
    }

    // ---- Host (used by the bridge inside the mini chat) ----
    @Override public Context context() { return ctx; }
    @Override public void runOnUi(Runnable r) { main.post(r); }
    @Override public void openExternal(String url) {
        collapse();
        try { ctx.startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
    }
    @Override public Voice voice() {
        if (voice == null) voice = new Voice(this, web);
        return voice;
    }
    @Override public void requestPermissions(String[] perms, int code) {
        collapse();
        ctx.startActivity(new Intent(ctx, MainActivity.class).putExtra("askPermissions", perms).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    @Override public void reloadWhenReady() { if (web != null) web.reload(); }
    @Override public void minimize() { runOnUi(new Runnable() { @Override public void run() { collapse(); } }); }
    @Override public void openApp() {
        runOnUi(new Runnable() {
            @Override public void run() {
                collapse();
                ctx.startActivity(new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            }
        });
    }
    @Override public void setBadge(final String kind) {
        runOnUi(new Runnable() {
            @Override public void run() {
                if (dot == null || expanded) return;
                if (kind == null || kind.isEmpty()) { dot.setVisibility(View.GONE); return; }
                GradientDrawable d = (GradientDrawable) dot.getBackground();
                d.setColor(Color.parseColor("input".equals(kind) ? "#ffcc66" : "#3dff8f"));
                dot.setVisibility(View.VISIBLE);
                // a question or approval brings the chat up by itself
                if ("input".equals(kind) && !appFront) expand();
            }
        });
    }
    @Override public boolean isBubble() { return true; }
}
