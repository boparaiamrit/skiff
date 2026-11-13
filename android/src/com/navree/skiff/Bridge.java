package com.navree.skiff;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/** Phone features exposed to the web UI as window.SkiffBridge (in the app and in the bubble). */
public class Bridge {
    private final Host host;

    Bridge(Host host) { this.host = host; }

    private Context ctx() { return host.context(); }

    private void onUi(Runnable r) { host.runOnUi(r); }

    private void start(Intent i) {
        try { ctx().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception e) { AppLog.i("start " + i + ": " + e); }
    }

    @JavascriptInterface public boolean isBubble() { return host.isBubble(); }

    @JavascriptInterface public void openExternal(final String url) {
        onUi(new Runnable() { @Override public void run() { host.openExternal(url); } });
    }

    @JavascriptInterface public void copyText(final String text) {
        onUi(new Runnable() {
            @Override public void run() {
                ClipboardManager cm = (ClipboardManager) ctx().getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Skiff", text));
            }
        });
    }

    @JavascriptInterface public String readClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) ctx().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData d = cm.getPrimaryClip();
            if (d == null || d.getItemCount() == 0) return "";
            CharSequence t = d.getItemAt(0).coerceToText(ctx());
            return t == null ? "" : t.toString();
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface public void toast(final String msg) {
        onUi(new Runnable() { @Override public void run() { Toast.makeText(ctx(), msg, Toast.LENGTH_SHORT).show(); } });
    }

    // ---- voice ----
    @JavascriptInterface public boolean speechAvailable() { return host.voice().available(); }
    @JavascriptInterface public boolean hasMic() { return host.voice().hasMic(); }
    @JavascriptInterface public void requestMic() { onUi(new Runnable() { @Override public void run() { host.voice().requestMic(); } }); }
    @JavascriptInterface public void listen(final String lang) { onUi(new Runnable() { @Override public void run() { host.voice().start(lang); } }); }
    @JavascriptInterface public void listenOffline(final String lang) { onUi(new Runnable() { @Override public void run() { host.voice().start(lang, true); } }); }
    @JavascriptInterface public boolean offlineSpeechAvailable() { return Recognizers.offlineAvailable(ctx()); }

    // ---- digital assistant (side button) ----
    @JavascriptInterface public boolean isDefaultAssistant() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                android.app.role.RoleManager rm = ctx().getSystemService(android.app.role.RoleManager.class);
                if (rm != null && rm.isRoleAvailable(android.app.role.RoleManager.ROLE_ASSISTANT))
                    return rm.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT);
            }
            String v = Settings.Secure.getString(ctx().getContentResolver(), "voice_interaction_service");
            return v != null && v.startsWith(ctx().getPackageName() + "/");
        } catch (Exception e) {
            return false;
        }
    }
    @JavascriptInterface public void openAssistantSettings() {
        Intent i = new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS);
        if (i.resolveActivity(ctx().getPackageManager()) == null) i = new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
        start(i);
    }
    @JavascriptInterface public void openDefaultApps() { start(new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)); }
    @JavascriptInterface public boolean tryAssistant() { return AssistService.show(); }
    @JavascriptInterface public boolean isAssistant() { return host instanceof AssistSession; }
    /** The assistant page says which part of the screen takes touches (CSS pixels). */
    @JavascriptInterface public void assistTouchRegion(int x, int y, int w, int h) {
        if (host instanceof AssistSession) ((AssistSession) host).setTouchRegion(x, y, w, h);
    }
    @JavascriptInterface public void assistTouchFull() {
        if (host instanceof AssistSession) ((AssistSession) host).setTouchAll();
    }
    @JavascriptInterface public void haptic() {
        if (host instanceof AssistSession) ((AssistSession) host).haptic();
    }
    @JavascriptInterface public void stopListening() { onUi(new Runnable() { @Override public void run() { host.voice().stop(); } }); }
    @JavascriptInterface public void cancelListening() { onUi(new Runnable() { @Override public void run() { host.voice().cancel(); } }); }
    @JavascriptInterface public void speak(final String text, final String lang) { onUi(new Runnable() { @Override public void run() { host.voice().speak(text, lang); } }); }
    /** Pause other audio for the whole conversation (true) or let it play again (false). */
    @JavascriptInterface public void audioFocus(final boolean on) { onUi(new Runnable() { @Override public void run() { host.voice().pin(on); } }); }
    @JavascriptInterface public void stopSpeaking() { onUi(new Runnable() { @Override public void run() { host.voice().stopSpeaking(); } }); }

    @JavascriptInterface public void notify(final String title, final String text) {
        if (host.isBubble()) return; // the bubble shows its own badge
        SkiffService s = SkiffService.get();
        if (s != null) s.notifyAttention(title, text);
    }

    // ---- bubble ----
    @JavascriptInterface public void minimize() { host.minimize(); }
    @JavascriptInterface public void openApp() { host.openApp(); }
    @JavascriptInterface public void setBadge(String kind) { host.setBadge(kind); }
    @JavascriptInterface public boolean bubbleEnabled() { return Bubble.enabled(ctx()); }
    @JavascriptInterface public boolean bubbleRunning() { return Bubble.running(); }
    @JavascriptInterface public void setBubbleEnabled(boolean on) { Bubble.setEnabled(ctx(), on); }
    @JavascriptInterface public void bubbleBusy(boolean busy) { Bubble.setBusy(busy); }
    @JavascriptInterface public boolean canDrawOverlays() { return Settings.canDrawOverlays(ctx()); }
    @JavascriptInterface public void requestOverlay() {
        start(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx().getPackageName())));
    }

    // ---- phone control ----
    /** {on, enabledInSettings, policy, stopped, log} */
    @JavascriptInterface public String phoneState() { return Phone.state(ctx()).toString(); }
    @JavascriptInterface public boolean phoneControlOn() { return SkiffHands.get() != null; }
    @JavascriptInterface public boolean phoneControlEnabledInSettings() { return Phone.enabledInSettings(ctx()); }
    @JavascriptInterface public void openAccessibilitySettings() { start(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
    @JavascriptInterface public void openAppInfo() {
        start(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx().getPackageName())));
    }
    @JavascriptInterface public String getPhonePolicy() { return PhoneTools.policy(ctx()); }
    @JavascriptInterface public void setPhonePolicy(String p) {
        PhoneTools.prefs(ctx()).edit().putString("phonePolicy", p).apply();
        PhoneTools.allowAllUntil = 0;
    }
    @JavascriptInterface public boolean phoneStopped() { return PhoneTools.stopped; }
    @JavascriptInterface public void setPhoneStopped(boolean s) { PhoneTools.stopped = s; }
    @JavascriptInterface public String phoneLog() { return PhoneTools.log().toString(); }
    @JavascriptInterface public String phoneStatus() {
        try {
            return Phone.call(ctx(), new JSONObject().put("tool", "status")).toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    // ---- app settings ----
    @JavascriptInterface public boolean isKeepAwake() {
        SkiffService s = SkiffService.get();
        return s != null && s.isKeepAwake();
    }

    @JavascriptInterface public void setKeepAwake(final boolean on) {
        onUi(new Runnable() {
            @Override public void run() {
                SkiffService s = SkiffService.get();
                if (s != null) s.setKeepAwake(on);
            }
        });
    }

    @JavascriptInterface public boolean isBatteryExempt() {
        PowerManager pm = (PowerManager) ctx().getSystemService(Context.POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(ctx().getPackageName());
    }

    @JavascriptInterface public void requestBatteryExemption() {
        try {
            start(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx().getPackageName())));
        } catch (Exception e) {
            start(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    @JavascriptInterface public boolean hasStorage() {
        return ctx().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @JavascriptInterface public void requestStorage() {
        onUi(new Runnable() {
            @Override public void run() {
                host.requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, MainActivity.REQ_STORAGE);
            }
        });
    }

    @JavascriptInterface public String appVersion() {
        try {
            return ctx().getPackageManager().getPackageInfo(ctx().getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface public String getAppLog() { return AppLog.dump(); }

    @JavascriptInterface public void restartServer() {
        new Thread(new Runnable() {
            @Override public void run() {
                SkiffService s = SkiffService.get();
                if (s != null) s.restartBackend();
                else SkiffService.start(ctx());
                onUi(new Runnable() { @Override public void run() { host.reloadWhenReady(); } });
            }
        }).start();
    }
}
