package com.navree.skiff;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Display;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Skiff phone control: the Accessibility service that lets Claude read the screen
 * and tap, type and scroll when the user asks it to do something on the
 * phone. It only acts on requests from Skiff's local phone server, shows a
 * banner while it works, and asks on screen before risky actions.
 */
public class SkiffHands extends AccessibilityService {
    private static volatile SkiffHands instance;
    private final Handler main = new Handler(Looper.getMainLooper());

    // the last screen snapshot: element ids index into this list
    private final List<AccessibilityNodeInfo> nodes = new ArrayList<>();
    private final ArrayDeque<JSONObject> notifications = new ArrayDeque<>();
    volatile String foregroundPackage = "";
    volatile String foregroundClass = "";

    private View banner;
    private View prompt;
    private final Runnable hideBanner = new Runnable() { @Override public void run() { removeView(banner); banner = null; } };


    public static SkiffHands get() { return instance; }

    @Override protected void onServiceConnected() {
        instance = this;
        PhoneTools.stopped = false;
        AppLog.i("phone control connected");
        Bubble.ensure(this); // the bubble can also draw through this service
    }

    @Override public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        AppLog.i("phone control disconnected");
        return super.onUnbind(intent);
    }

    @Override public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override public void onInterrupt() {}

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        int t = e.getEventType();
        if (t == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && e.getPackageName() != null) {
            String pkg = e.getPackageName().toString();
            if (!pkg.equals(getPackageName()) || foregroundPackage.isEmpty()) {
                foregroundPackage = pkg;
                foregroundClass = e.getClassName() != null ? e.getClassName().toString() : "";
            }
        } else if (t == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED && e.getPackageName() != null) {
            StringBuilder sb = new StringBuilder();
            for (CharSequence c : e.getText()) if (c != null) sb.append(c).append(' ');
            if (sb.length() == 0) return;
            try {
                JSONObject n = new JSONObject();
                n.put("app", e.getPackageName().toString());
                n.put("text", sb.toString().trim());
                n.put("time", System.currentTimeMillis());
                synchronized (notifications) {
                    notifications.addLast(n);
                    while (notifications.size() > 60) notifications.removeFirst();
                }
            } catch (Exception ignored) {}
        }
    }

    JSONArray recentNotifications() {
        JSONArray a = new JSONArray();
        synchronized (notifications) { for (JSONObject n : notifications) a.put(n); }
        return a;
    }

    // ---------------------------------------------------------------- screen

    /** Reads the screen into a flat list of meaningful elements. */
    JSONObject snapshot() throws Exception {
        synchronized (nodes) { nodes.clear(); }
        // app windows first (so "app" names the app in front), then dialogs,
        // keyboard and system bars; Skiff's own bubble/app are left out
        List<AccessibilityNodeInfo> roots = new ArrayList<>();
        List<AccessibilityNodeInfo> rest = new ArrayList<>();
        for (AccessibilityWindowInfo w : getWindows()) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue;
            AccessibilityNodeInfo r = w.getRoot();
            String rp = r == null || r.getPackageName() == null ? "" : r.getPackageName().toString();
            if (r == null || rp.equals(getPackageName())) continue; // Skiff's own chat and bubble
            if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) roots.add(r);
            else rest.add(r);
        }
        roots.addAll(rest);
        if (roots.isEmpty()) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) roots.add(r);
        }
        JSONArray els = new JSONArray();
        StringBuilder text = new StringBuilder();
        String pkg = "";
        for (AccessibilityNodeInfo r : roots) {
            if (pkg.isEmpty() && r.getPackageName() != null) pkg = r.getPackageName().toString();
            walk(r, 0, els, text);
        }
        if (pkg.isEmpty()) pkg = foregroundPackage;
        JSONObject o = new JSONObject();
        o.put("app", pkg);
        o.put("appName", PhoneTools.appLabel(this, pkg));
        o.put("elements", els.length());
        o.put("screen", text.toString());
        return o;
    }

    private void walk(AccessibilityNodeInfo n, int depth, JSONArray els, StringBuilder text) throws Exception {
        if (n == null || depth > 60 || els.length() >= 300) return;
        if (!n.isVisibleToUser()) return;
        String label = label(n);
        boolean click = n.isClickable() || n.isLongClickable();
        boolean edit = n.isEditable();
        boolean scroll = n.isScrollable();
        boolean check = n.isCheckable();
        if (!label.isEmpty() || click || edit || scroll || check) {
            int id;
            synchronized (nodes) { nodes.add(n); id = nodes.size() - 1; }
            Rect b = new Rect();
            n.getBoundsInScreen(b);
            StringBuilder line = new StringBuilder();
            line.append('[').append(id).append("] ").append(role(n));
            if (!label.isEmpty()) line.append(" \"").append(label).append('"');
            ArrayList<String> flags = new ArrayList<>();
            if (click) flags.add("tap");
            if (edit) flags.add(n.isPassword() ? "password field" : "field");
            if (scroll) flags.add("scroll");
            if (check) flags.add(n.isChecked() ? "on" : "off");
            if (n.isFocused()) flags.add("focused");
            if (n.isSelected()) flags.add("selected");
            if (!n.isEnabled()) flags.add("disabled");
            if (!flags.isEmpty()) line.append(" (").append(join(flags)).append(')');
            line.append(" @").append(b.centerX()).append(',').append(b.centerY());
            text.append(line).append('\n');
            els.put(id);
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), depth + 1, els, text);
    }

    private static String join(List<String> l) {
        StringBuilder sb = new StringBuilder();
        for (String s : l) { if (sb.length() > 0) sb.append(", "); sb.append(s); }
        return sb.toString();
    }

    static String label(AccessibilityNodeInfo n) {
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        String s = t != null && t.length() > 0 ? t.toString() : d != null ? d.toString() : "";
        if (s.isEmpty() && n.isEditable() && Build.VERSION.SDK_INT >= 26 && n.getHintText() != null) s = "hint: " + n.getHintText();
        if (n.isPassword() && t != null && t.length() > 0) s = "••••";
        s = s.replace('\n', ' ').trim();
        return s.length() > 90 ? s.substring(0, 90) + "…" : s;
    }

    private static String role(AccessibilityNodeInfo n) {
        String c = n.getClassName() == null ? "" : n.getClassName().toString();
        c = c.substring(c.lastIndexOf('.') + 1);
        if (n.isEditable()) return "Field";
        if (c.contains("Switch")) return "Switch";
        if (c.contains("CheckBox")) return "Checkbox";
        if (c.contains("RadioButton")) return "Radio";
        if (c.contains("Button")) return "Button";
        if (c.contains("Image")) return n.isClickable() ? "Button" : "Image";
        if (c.contains("RecyclerView") || c.contains("ListView") || c.contains("ScrollView")) return "List";
        if (c.contains("TextView")) return n.isClickable() ? "Button" : "Text";
        if (c.contains("WebView")) return "Web";
        return n.isClickable() ? "Item" : "View";
    }

    AccessibilityNodeInfo node(int id) {
        synchronized (nodes) { return id >= 0 && id < nodes.size() ? nodes.get(id) : null; }
    }

    /** Finds the best element whose label matches text (exact first, then contains). */
    AccessibilityNodeInfo find(String text) throws Exception {
        snapshot();
        String q = text.toLowerCase(Locale.ROOT).trim();
        AccessibilityNodeInfo contains = null;
        synchronized (nodes) {
            for (AccessibilityNodeInfo n : nodes) {
                String l = label(n).toLowerCase(Locale.ROOT);
                if (l.equals(q)) return n;
                if (contains == null && !q.isEmpty() && l.contains(q)) contains = n;
            }
        }
        return contains;
    }

    AccessibilityNodeInfo focusedField() {
        AccessibilityNodeInfo f = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f != null && f.isEditable()) return f;
        synchronized (nodes) { for (AccessibilityNodeInfo n : nodes) if (n.isEditable() && n.isFocused()) return n; }
        synchronized (nodes) { for (AccessibilityNodeInfo n : nodes) if (n.isEditable()) return n; }
        return null;
    }

    // --------------------------------------------------------------- actions

    boolean click(AccessibilityNodeInfo n, boolean longPress) throws Exception {
        AccessibilityNodeInfo c = n;
        int action = longPress ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK;
        for (int i = 0; c != null && i < 6; i++, c = c.getParent()) {
            if ((longPress ? c.isLongClickable() : c.isClickable()) && c.performAction(action)) return true;
        }
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        return tapAt(b.centerX(), b.centerY(), longPress ? 700 : 60);
    }

    boolean tapAt(int x, int y, long ms) throws Exception {
        Path p = new Path();
        p.moveTo(x, y);
        return gesture(p, ms);
    }

    boolean swipe(int x1, int y1, int x2, int y2, long ms) throws Exception {
        Path p = new Path();
        p.moveTo(x1, y1);
        p.lineTo(x2, y2);
        return gesture(p, ms);
    }

    private boolean gesture(Path p, long ms) throws Exception {
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, ms))).build();
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicBoolean ok = new AtomicBoolean(false);
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { ok.set(true); done.countDown(); }
            @Override public void onCancelled(GestureDescription d) { done.countDown(); }
        }, main);
        if (!sent) return false;
        done.await(ms + 3000, TimeUnit.MILLISECONDS);
        return ok.get();
    }

    boolean setText(AccessibilityNodeInfo n, String text) {
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
    }

    boolean submit(AccessibilityNodeInfo n) {
        if (Build.VERSION.SDK_INT >= 30) {
            return n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return false;
    }

    boolean scroll(AccessibilityNodeInfo target, String dir) throws Exception {
        boolean forward = "down".equals(dir) || "right".equals(dir);
        AccessibilityNodeInfo s = target;
        if (s == null) {
            int best = -1;
            synchronized (nodes) {
                for (AccessibilityNodeInfo n : nodes) {
                    if (!n.isScrollable()) continue;
                    Rect b = new Rect();
                    n.getBoundsInScreen(b);
                    int area = b.width() * b.height();
                    if (area > best) { best = area; s = n; }
                }
            }
        }
        if (s != null && s.performAction(forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return true;
        Display d = ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay();
        int w = d.getWidth(), h = d.getHeight();
        switch (dir) {
            case "down": return swipe(w / 2, h * 3 / 4, w / 2, h / 4, 350);
            case "up": return swipe(w / 2, h / 4, w / 2, h * 3 / 4, 350);
            case "right": return swipe(w * 4 / 5, h / 2, w / 5, h / 2, 300);
            default: return swipe(w / 5, h / 2, w * 4 / 5, h / 2, 300);
        }
    }

    /** Takes a screenshot (Android 11+) as a JPEG, base64, at most 1080 px on the long side. */
    String screenshot() throws Exception {
        if (Build.VERSION.SDK_INT < 30) throw new Exception("screenshots need Android 11 or newer");
        final CountDownLatch done = new CountDownLatch(1);
        final String[] out = new String[1];
        final String[] err = new String[1];
        removeView(banner); // keep our own banner out of the picture
        removeView(prompt);
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult r) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                    Bitmap bm = hw.copy(Bitmap.Config.ARGB_8888, false);
                    r.getHardwareBuffer().close();
                    float scale = Math.min(1f, 1080f / Math.max(bm.getWidth(), bm.getHeight()));
                    if (scale < 1f) bm = Bitmap.createScaledBitmap(bm, Math.round(bm.getWidth() * scale), Math.round(bm.getHeight() * scale), true);
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    bm.compress(Bitmap.CompressFormat.JPEG, 72, bos);
                    out[0] = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                } catch (Exception e) {
                    err[0] = e.toString();
                }
                done.countDown();
            }
            @Override public void onFailure(int code) { err[0] = "screenshot failed (" + code + ")"; done.countDown(); }
        });
        done.await(8, TimeUnit.SECONDS);
        if (out[0] == null) throw new Exception(err[0] != null ? err[0] : "screenshot timed out");
        return out[0];
    }

    // ---------------------------------------------------------------- overlays

    private WindowManager.LayoutParams overlayParams(int gravity, boolean touchable) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | (touchable ? 0 : WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
                PixelFormat.TRANSLUCENT);
        lp.gravity = gravity;
        return lp;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void removeView(final View v) {
        if (v == null) return;
        main.post(new Runnable() {
            @Override public void run() {
                try { ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(v); } catch (Exception ignored) {}
            }
        });
    }

    private GradientDrawable panel(int color, int radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radius));
        g.setStroke(dp(1), Color.parseColor("#2f5a41"));
        return g;
    }

    /** A small banner at the top while Claude works, with a Stop button. */
    void showBanner(final String what) {
        main.post(new Runnable() {
            @Override public void run() {
                main.removeCallbacks(hideBanner);
                WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
                if (banner == null) {
                    LinearLayout row = new LinearLayout(SkiffHands.this);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    row.setGravity(Gravity.CENTER_VERTICAL);
                    row.setPadding(dp(14), dp(8), dp(8), dp(8));
                    row.setBackground(panel(Color.parseColor("#E6111713"), 22));
                    TextView t = new TextView(SkiffHands.this);
                    t.setTextColor(Color.parseColor("#e3ece6"));
                    t.setTextSize(13);
                    t.setSingleLine(true);
                    t.setTag("text");
                    row.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
                    Button stop = new Button(SkiffHands.this);
                    stop.setText("Stop");
                    stop.setAllCaps(false);
                    stop.setTextColor(Color.parseColor("#062611"));
                    stop.setBackground(pill(Color.parseColor("#3dff8f")));
                    stop.setMinHeight(0);
                    stop.setMinimumHeight(0);
                    stop.setPadding(dp(14), dp(6), dp(14), dp(6));
                    stop.setOnClickListener(new View.OnClickListener() {
                        @Override public void onClick(View v) {
                            PhoneTools.stopped = true;
                            removeView(banner);
                            banner = null;
                            AppLog.i("phone control stopped by the user");
                        }
                    });
                    row.addView(stop);
                    LinearLayout wrap = new LinearLayout(SkiffHands.this);
                    wrap.setPadding(dp(12), dp(36), dp(12), 0);
                    wrap.addView(row, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
                    banner = wrap;
                    try { wm.addView(banner, overlayParams(Gravity.TOP, true)); } catch (Exception e) { banner = null; return; }
                }
                TextView t = banner.findViewWithTag("text");
                if (t != null) t.setText("✳ Claude: " + what);
                main.postDelayed(hideBanner, 4000);
            }
        });
    }

    private GradientDrawable pill(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(18));
        return g;
    }

    /**
     * Asks the user on screen, over whatever app is open. Blocks the calling
     * (non-UI) thread. Returns 0 = deny, 1 = allow, 2 = allow everything for 30 minutes.
     */
    int ask(final String title, final String detail, long timeoutMs) throws InterruptedException {
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicInteger answer = new AtomicInteger(0);
        main.post(new Runnable() {
            @Override public void run() {
                removeView(prompt);
                LinearLayout box = new LinearLayout(SkiffHands.this);
                box.setOrientation(LinearLayout.VERTICAL);
                box.setPadding(dp(18), dp(16), dp(18), dp(14));
                box.setBackground(panel(Color.parseColor("#F2111713"), 20));
                TextView h = new TextView(SkiffHands.this);
                h.setText("✳ " + title);
                h.setTextColor(Color.parseColor("#e3ece6"));
                h.setTextSize(16);
                h.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
                box.addView(h);
                if (detail != null && !detail.isEmpty()) {
                    TextView d = new TextView(SkiffHands.this);
                    d.setText(detail);
                    d.setTextColor(Color.parseColor("#8b9a91"));
                    d.setTextSize(13.5f);
                    d.setPadding(0, dp(6), 0, 0);
                    box.addView(d);
                }
                LinearLayout row = new LinearLayout(SkiffHands.this);
                row.setPadding(0, dp(14), 0, 0);
                row.setGravity(Gravity.END);
                String[] labels = {"Deny", "Allow all (30 min)", "Allow"};
                final int[] values = {0, 2, 1};
                for (int i = 0; i < labels.length; i++) {
                    Button b = new Button(SkiffHands.this);
                    b.setText(labels[i]);
                    b.setAllCaps(false);
                    b.setTextSize(14);
                    boolean primary = values[i] == 1;
                    b.setTextColor(Color.parseColor(primary ? "#062611" : "#e3ece6"));
                    b.setBackground(pill(Color.parseColor(primary ? "#3dff8f" : "#18201b")));
                    b.setMinHeight(0);
                    b.setMinimumHeight(0);
                    b.setPadding(dp(14), dp(8), dp(14), dp(8));
                    final int v = values[i];
                    b.setOnClickListener(new View.OnClickListener() {
                        @Override public void onClick(View view) {
                            answer.set(v);
                            removeView(prompt);
                            prompt = null;
                            done.countDown();
                        }
                    });
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                    lp.setMarginStart(dp(8));
                    row.addView(b, lp);
                }
                box.addView(row);
                LinearLayout wrap = new LinearLayout(SkiffHands.this);
                wrap.setPadding(dp(12), 0, dp(12), dp(28));
                wrap.addView(box, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
                prompt = wrap;
                try {
                    ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(prompt, overlayParams(Gravity.BOTTOM, true));
                } catch (Exception e) {
                    AppLog.i("cannot show prompt: " + e);
                    prompt = null;
                    done.countDown();
                }
            }
        });
        if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            removeView(prompt);
            prompt = null;
            return 0;
        }
        return answer.get();
    }
}
