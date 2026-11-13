package com.navree.skiff;

import android.app.SearchManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The phone tools Claude can call (through skiffd's MCP server). Decides
 * which actions need an on-screen confirmation, runs them, and keeps a log
 * the user can review in Skiff.
 */
public final class PhoneTools {
    private PhoneTools() {}

    static volatile boolean stopped;
    static volatile long allowAllUntil;
    private static final ArrayDeque<JSONObject> LOG = new ArrayDeque<>();

    // words on a button that make tapping it consequential
    private static final Pattern RISKY = Pattern.compile(
            "\\b(send|pay|payment|buy|purchase|order|checkout|place order|confirm|delete|remove|uninstall|transfer|call|post|publish|submit|share|sign out|log ?out|reset|erase|format|install|subscribe|unsubscribe|book|accept|approve|block|report|unfriend|unfollow)\\b",
            Pattern.CASE_INSENSITIVE);
    // apps where every action asks first
    private static final Pattern SENSITIVE_APP = Pattern.compile(
            "bank|pay|upi|wallet|paisa|phonepe|paytm|bhim|finance|crypto|binance|coinbase|zerodha|groww|upstox|1password|bitwarden|lastpass|keepass|authenticator|com\\.android\\.settings\\.security",
            Pattern.CASE_INSENSITIVE);

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("skiff", Context.MODE_PRIVATE); }

    /** ask = every action asks; risky = only risky actions ask (default); auto = never asks. */
    static String policy(Context c) { return prefs(c).getString("phonePolicy", "risky"); }

    static JSONArray log() {
        JSONArray a = new JSONArray();
        synchronized (LOG) { for (JSONObject o : LOG) a.put(o); }
        return a;
    }

    private static void record(String tool, String what, String result) {
        try {
            JSONObject o = new JSONObject();
            o.put("time", System.currentTimeMillis());
            o.put("tool", tool);
            o.put("what", what);
            o.put("result", result);
            synchronized (LOG) {
                LOG.addLast(o);
                while (LOG.size() > 200) LOG.removeFirst();
            }
        } catch (Exception ignored) {}
    }

    static String appLabel(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private static JSONObject err(String msg) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", false);
        o.put("error", msg);
        return o;
    }

    private static SkiffHands hands() throws Exception {
        SkiffHands h = SkiffHands.get();
        if (h == null) throw new Exception("Phone control is off. Ask the user to turn on Skiff phone control in Android Settings → Accessibility (Skiff → Setup → Phone control shows how).");
        return h;
    }

    /** Confirms an action on screen if the policy requires it. Returns null if allowed, else an error result. */
    private static JSONObject gate(Context c, String tool, String what, boolean risky) throws Exception {
        if (stopped) return err("The user stopped phone control from the on-screen banner. Ask them before continuing; they can turn it back on in Skiff.");
        String p = policy(c);
        boolean ask = "ask".equals(p) || ("risky".equals(p) && risky);
        if (!ask || System.currentTimeMillis() < allowAllUntil) return null;
        SkiffHands h = SkiffHands.get();
        if (h == null) return err("This action needs the user's confirmation, but phone control (Accessibility) is off.");
        int a = h.ask("Claude wants to " + what, "In " + appLabel(c, h.foregroundPackage) + ". Allow?", 120000);
        if (a == 2) allowAllUntil = System.currentTimeMillis() + 30 * 60 * 1000;
        if (a == 0) {
            record(tool, what, "denied");
            JSONObject o = err("The user denied this on the phone: " + what);
            o.put("denied", true);
            return o;
        }
        return null;
    }

    private static boolean riskyNode(AccessibilityNodeInfo n, String pkg) {
        if (n == null) return false;
        if (n.isPassword()) return true;
        if (pkg != null && SENSITIVE_APP.matcher(pkg).find()) return true;
        String l = SkiffHands.label(n);
        AccessibilityNodeInfo p = n.getParent();
        if (l.isEmpty() && p != null) l = SkiffHands.label(p);
        return RISKY.matcher(l).find();
    }

    private static void pause(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

    /** After an action, wait briefly and return the new screen so Claude needn't ask again. */
    private static JSONObject after(SkiffHands h, String tool, String what, boolean ok) throws Exception {
        record(tool, what, ok ? "ok" : "failed");
        pause(900);
        JSONObject o = new JSONObject();
        o.put("ok", ok);
        if (!ok) o.put("error", "The action did not take effect. Read the screen again and try another element or coordinates.");
        try { o.put("after", h.snapshot()); } catch (Exception ignored) {}
        return o;
    }

    public static JSONObject call(Context c, JSONObject req) {
        String tool = req.optString("tool");
        JSONObject a = req.optJSONObject("args");
        if (a == null) a = new JSONObject();
        try {
            // Android only lets an app with a running accessibility service
            // open other apps from the background, so every tool needs it on.
            if (SkiffHands.get() == null && !tool.equals("status") && !tool.equals("log") && !tool.equals("media") && !tool.equals("unlock"))
                return err("Phone control is off. Ask the user to turn on Skiff phone control in Android Settings → Accessibility → Installed apps (Skiff → Setup → Phone control shows how).");
            return run(c, tool, a);
        } catch (Exception e) {
            AppLog.i("phone " + tool + ": " + e);
            try { return err(e.getMessage() != null ? e.getMessage() : e.toString()); } catch (Exception x) { return new JSONObject(); }
        }
    }

    private static JSONObject run(Context c, String tool, JSONObject a) throws Exception {
        JSONObject o = new JSONObject();
        switch (tool) {
            case "unlock": {
                android.app.KeyguardManager km = (android.app.KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
                if (km == null || !km.isKeyguardLocked()) { o.put("ok", true); o.put("unlocked", true); return o; }
                java.util.concurrent.CountDownLatch l = new java.util.concurrent.CountDownLatch(1);
                UnlockActivity.latch = l;
                UnlockActivity.unlocked = false;
                c.startActivity(new Intent(c, UnlockActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION));
                boolean answered = l.await(60, java.util.concurrent.TimeUnit.SECONDS);
                UnlockActivity.latch = null;
                boolean ok = answered && UnlockActivity.unlocked && !km.isKeyguardLocked();
                record(tool, "asked to unlock", ok ? "ok" : "still locked");
                o.put("ok", ok);
                o.put("unlocked", ok);
                if (!ok) o.put("note", "The phone is still locked. Tell the user to unlock it, or continue with what works on the lock screen.");
                return o;
            }
            case "status": {
                android.app.KeyguardManager km = (android.app.KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
                android.os.PowerManager pm = (android.os.PowerManager) c.getSystemService(Context.POWER_SERVICE);
                if (km != null) o.put("locked", km.isKeyguardLocked());
                if (pm != null) o.put("screenOn", pm.isInteractive());
                o.put("assistantOpen", AssistSession.showing());
                o.put("phoneControl", SkiffHands.get() != null);
                o.put("stopped", stopped);
                o.put("policy", policy(c));
                o.put("screenshots", Build.VERSION.SDK_INT >= 30);
                o.put("android", Build.VERSION.RELEASE);
                o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                BatteryManager bm = (BatteryManager) c.getSystemService(Context.BATTERY_SERVICE);
                o.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
                o.put("charging", bm.isCharging());
                SkiffHands h = SkiffHands.get();
                if (h != null) o.put("app", h.foregroundPackage);
                return o;
            }
            case "read_screen": {
                SkiffHands h = hands();
                o = h.snapshot();
                o.put("hint", "Use the [number] ids with tap/type/scroll. Elements marked (tap) are tappable.");
                return o;
            }
            case "screenshot": {
                SkiffHands h = hands();
                if (stopped) return gate(c, tool, "", false);
                pause(250);
                o.put("image", h.screenshot());
                o.put("mime", "image/jpeg");
                record(tool, "took a screenshot", "ok");
                return o;
            }
            case "tap":
            case "long_press": {
                SkiffHands h = hands();
                boolean lp = tool.equals("long_press");
                AccessibilityNodeInfo n = null;
                String what;
                if (a.has("id")) {
                    n = h.node(a.getInt("id"));
                    if (n == null) return err("No element with id " + a.getInt("id") + ". Call read_screen first; ids change after every screen change.");
                } else if (a.has("text")) {
                    n = h.find(a.getString("text"));
                    if (n == null) return err("Nothing on screen matches \"" + a.getString("text") + "\".");
                }
                if (n != null) {
                    String l = SkiffHands.label(n);
                    what = (lp ? "long-press " : "tap ") + (l.isEmpty() ? "an element" : "\"" + l + "\"");
                } else if (a.has("x") && a.has("y")) {
                    what = (lp ? "long-press" : "tap") + " at " + a.getInt("x") + "," + a.getInt("y");
                } else return err("Give an id, text, or x and y.");
                JSONObject g = gate(c, tool, what, riskyNode(n, h.foregroundPackage) || (n == null && SENSITIVE_APP.matcher(h.foregroundPackage).find()));
                if (g != null) return g;
                h.showBanner(what);
                boolean ok = n != null ? h.click(n, lp) : h.tapAt(a.getInt("x"), a.getInt("y"), lp ? 700 : 60);
                return after(h, tool, what, ok);
            }
            case "type": {
                SkiffHands h = hands();
                String text = a.getString("text");
                AccessibilityNodeInfo n = a.has("id") ? h.node(a.getInt("id")) : null;
                if (n == null) {
                    h.snapshot();
                    n = h.focusedField();
                }
                if (n == null || !n.isEditable()) return err("No text field found. Tap a field first, or pass its id.");
                boolean append = a.optBoolean("append", false);
                String full = append && n.getText() != null && !n.isShowingHintText() ? n.getText() + text : text;
                String what = "type \"" + (text.length() > 60 ? text.substring(0, 60) + "…" : text) + "\"" + (n.isPassword() ? " into a password field" : "");
                JSONObject g = gate(c, tool, what, riskyNode(n, h.foregroundPackage));
                if (g != null) return g;
                h.showBanner(what);
                boolean ok = h.setText(n, full);
                if (ok && a.optBoolean("submit", false)) {
                    pause(150);
                    if (!h.submit(n)) h.showBanner("pressed enter");
                }
                return after(h, tool, what, ok);
            }
            case "scroll": {
                SkiffHands h = hands();
                String dir = a.optString("direction", "down");
                AccessibilityNodeInfo n = a.has("id") ? h.node(a.getInt("id")) : null;
                if (n == null) h.snapshot();
                JSONObject g = gate(c, tool, "scroll " + dir, false);
                if (g != null) return g;
                h.showBanner("scrolling " + dir);
                return after(h, tool, "scroll " + dir, h.scroll(n, dir));
            }
            case "swipe": {
                SkiffHands h = hands();
                String what = "swipe";
                JSONObject g = gate(c, tool, what, false);
                if (g != null) return g;
                h.showBanner(what);
                return after(h, tool, what, h.swipe(a.getInt("x1"), a.getInt("y1"), a.getInt("x2"), a.getInt("y2"), a.optLong("ms", 300)));
            }
            case "press_key": {
                SkiffHands h = hands();
                String key = a.getString("key");
                int action;
                switch (key) {
                    case "back": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK; break;
                    case "home": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME; break;
                    case "recents": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS; break;
                    case "notifications": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS; break;
                    case "quick_settings": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS; break;
                    case "lock": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN; break;
                    case "screenshot": action = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT; break;
                    default: return err("Unknown key " + key + ". Use back, home, recents, notifications, quick_settings, lock or screenshot.");
                }
                JSONObject g = gate(c, tool, "press " + key, key.equals("lock"));
                if (g != null) return g;
                h.showBanner("pressing " + key);
                return after(h, tool, "press " + key, h.performGlobalAction(action));
            }
            case "wait_for": {
                SkiffHands h = hands();
                String text = a.getString("text").toLowerCase(Locale.ROOT);
                long until = System.currentTimeMillis() + Math.min(30000, a.optLong("timeout_ms", 8000));
                while (System.currentTimeMillis() < until) {
                    JSONObject s = h.snapshot();
                    if (s.optString("screen").toLowerCase(Locale.ROOT).contains(text)) {
                        s.put("found", true);
                        return s;
                    }
                    pause(500);
                }
                o = h.snapshot();
                o.put("found", false);
                return o;
            }
            case "list_apps": {
                PackageManager pm = c.getPackageManager();
                Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
                JSONArray arr = new JSONArray();
                for (ResolveInfo r : pm.queryIntentActivities(i, 0)) {
                    JSONObject x = new JSONObject();
                    x.put("name", r.loadLabel(pm).toString());
                    x.put("package", r.activityInfo.packageName);
                    arr.put(x);
                }
                o.put("apps", arr);
                return o;
            }
            case "open_app": {
                String name = a.optString("package", a.optString("name", "")).trim();
                PackageManager pm = c.getPackageManager();
                Intent launch = pm.getLaunchIntentForPackage(name);
                String label = name;
                if (launch == null) {
                    Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
                    List<ResolveInfo> all = pm.queryIntentActivities(i, 0);
                    String q = name.toLowerCase(Locale.ROOT);
                    ResolveInfo best = null;
                    for (ResolveInfo r : all) {
                        String l = r.loadLabel(pm).toString().toLowerCase(Locale.ROOT);
                        if (l.equals(q)) { best = r; break; }
                        if (best == null && l.contains(q)) best = r;
                    }
                    if (best == null) return err("No app called \"" + name + "\". Use list_apps to see installed apps.");
                    launch = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
                    label = best.loadLabel(pm).toString();
                }
                if (launch == null) return err("That app can't be opened.");
                JSONObject g = gate(c, tool, "open " + label, SENSITIVE_APP.matcher(launch.getPackage() == null ? name : launch.getPackage()).find());
                if (g != null) return g;
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(launch);
                SkiffHands h = SkiffHands.get();
                if (h == null) {
                    record(tool, "open " + label, "ok");
                    o.put("ok", true);
                    o.put("note", "Opened. Turn on phone control to read and use the screen.");
                    return o;
                }
                h.showBanner("opening " + label);
                pause(800);
                return after(h, tool, "open " + label, true);
            }
            case "open_url": {
                String url = a.getString("url");
                JSONObject g = gate(c, tool, "open " + url, false);
                if (g != null) return g;
                c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                record(tool, url, "ok");
                o.put("ok", true);
                return o;
            }
            case "play_music": {
                String q = a.optString("query", "").trim();
                String app = a.optString("app", "youtube_music");
                String pkg = app.equals("spotify") ? "com.spotify.music"
                        : app.equals("youtube_music") ? "com.google.android.apps.youtube.music"
                        : app.equals("default") || app.isEmpty() ? null : app;
                String what = q.isEmpty() ? "play music" : "play " + q;
                JSONObject g = gate(c, tool, what, false);
                if (g != null) return g;
                Intent i = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
                        .putExtra(SearchManager.QUERY, q)
                        .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (pkg != null) i.setPackage(pkg);
                try {
                    c.startActivity(i);
                } catch (ActivityNotFoundException e) {
                    if (!"com.google.android.apps.youtube.music".equals(pkg)) return err("No installed app plays music from a search" + (pkg != null ? " (" + pkg + ")" : "") + ". Try app=default, or open the app and search.");
                    c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://music.youtube.com/search?q=" + Uri.encode(q))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                }
                record(tool, what, "ok");
                o.put("ok", true);
                o.put("note", "The app starts playing the best match. Check with read_screen; if it only shows search results, tap the first result.");
                return o;
            }
            case "media": {
                String act = a.getString("action");
                AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
                int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                int key = -1;
                switch (act) {
                    case "play": key = KeyEvent.KEYCODE_MEDIA_PLAY; break;
                    case "pause": key = KeyEvent.KEYCODE_MEDIA_PAUSE; break;
                    case "toggle": key = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE; break;
                    case "next": key = KeyEvent.KEYCODE_MEDIA_NEXT; break;
                    case "previous": key = KeyEvent.KEYCODE_MEDIA_PREVIOUS; break;
                    case "stop": key = KeyEvent.KEYCODE_MEDIA_STOP; break;
                    case "volume_up": am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI); break;
                    case "volume_down": am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI); break;
                    case "mute": am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI); break;
                    case "unmute": am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, AudioManager.FLAG_SHOW_UI); break;
                    case "set_volume": {
                        int pct = Math.max(0, Math.min(100, a.getInt("level")));
                        am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(pct * max / 100f), AudioManager.FLAG_SHOW_UI);
                        break;
                    }
                    case "status": break;
                    default: return err("Unknown media action " + act);
                }
                if (key != -1) {
                    am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, key));
                    am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, key));
                    pause(400);
                }
                record(tool, act.replace('_', ' '), "ok");
                o.put("ok", true);
                o.put("playing", am.isMusicActive());
                o.put("volume", max > 0 ? Math.round(am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max) : 0);
                return o;
            }
            case "start_intent": {
                String action = a.optString("action", Intent.ACTION_VIEW);
                if (action.equals(Intent.ACTION_CALL) || action.contains("CALL_PRIVILEGED")) return err("Calling directly isn't allowed; use compose_message kind=call to open the dialler.");
                Intent i = new Intent(action);
                String data = a.optString("data", ""), type = a.optString("type", "");
                if (!data.isEmpty() && !type.isEmpty()) i.setDataAndType(Uri.parse(data), type);
                else if (!data.isEmpty()) i.setData(Uri.parse(data));
                else if (!type.isEmpty()) i.setType(type);
                if (a.has("package")) i.setPackage(a.getString("package"));
                if (a.has("category")) i.addCategory(a.getString("category"));
                JSONObject ex = a.optJSONObject("extras");
                if (ex != null) {
                    for (Iterator<String> it = ex.keys(); it.hasNext(); ) {
                        String k = it.next();
                        Object v = ex.get(k);
                        if (v instanceof Boolean) i.putExtra(k, (Boolean) v);
                        else if (v instanceof Integer) i.putExtra(k, (Integer) v);
                        else if (v instanceof Long) i.putExtra(k, (Long) v);
                        else if (v instanceof Number) i.putExtra(k, ((Number) v).doubleValue());
                        else i.putExtra(k, String.valueOf(v));
                    }
                }
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                String lower = data.toLowerCase(Locale.US);
                boolean risky = lower.startsWith("upi:") || lower.startsWith("tel:") || lower.contains("pay")
                        || (a.has("package") && SENSITIVE_APP.matcher(a.getString("package")).find());
                String what = "open " + (data.isEmpty() ? action.replace("android.intent.action.", "") : data);
                JSONObject g = gate(c, tool, what, risky);
                if (g != null) return g;
                try {
                    c.startActivity(i);
                } catch (ActivityNotFoundException e) {
                    return err("No app on the phone handles this intent.");
                }
                record(tool, what, "ok");
                o.put("ok", true);
                return o;
            }
            case "set_alarm": {
                int hour = a.getInt("hour"), minute = a.optInt("minute", 0);
                String what = String.format(Locale.US, "set an alarm for %02d:%02d", hour, minute);
                JSONObject g = gate(c, tool, what, false);
                if (g != null) return g;
                Intent i = new Intent(AlarmClock.ACTION_SET_ALARM)
                        .putExtra(AlarmClock.EXTRA_HOUR, hour).putExtra(AlarmClock.EXTRA_MINUTES, minute)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (a.has("label")) i.putExtra(AlarmClock.EXTRA_MESSAGE, a.getString("label"));
                c.startActivity(i);
                record(tool, what, "ok");
                o.put("ok", true);
                return o;
            }
            case "set_timer": {
                int secs = a.getInt("seconds");
                String what = "start a " + secs + "-second timer";
                JSONObject g = gate(c, tool, what, false);
                if (g != null) return g;
                Intent i = new Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, secs)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (a.has("label")) i.putExtra(AlarmClock.EXTRA_MESSAGE, a.getString("label"));
                c.startActivity(i);
                record(tool, what, "ok");
                o.put("ok", true);
                return o;
            }
            case "add_calendar_event": {
                SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US);
                Date start = f.parse(a.getString("start"));
                Date end = a.has("end") ? f.parse(a.getString("end")) : new Date(start.getTime() + 3600000);
                Intent i = new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                        .putExtra(CalendarContract.Events.TITLE, a.getString("title"))
                        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start.getTime())
                        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.getTime())
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (a.has("location")) i.putExtra(CalendarContract.Events.EVENT_LOCATION, a.getString("location"));
                if (a.has("description")) i.putExtra(CalendarContract.Events.DESCRIPTION, a.getString("description"));
                c.startActivity(i);
                record(tool, "new event " + a.getString("title"), "opened");
                o.put("ok", true);
                o.put("note", "The calendar app opened with the event filled in. Read the screen and tap Save, or let the user check it.");
                return o;
            }
            case "share_text": {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, a.getString("text"));
                c.startActivity(Intent.createChooser(send, "Share").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                record(tool, "share text", "opened");
                o.put("ok", true);
                return o;
            }
            case "compose_message": {
                String kind = a.optString("kind", "sms");
                String to = a.optString("to", "");
                Intent i;
                if (kind.equals("call")) i = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(to)));
                else if (kind.equals("email")) i = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(to)))
                        .putExtra(Intent.EXTRA_SUBJECT, a.optString("subject", "")).putExtra(Intent.EXTRA_TEXT, a.optString("text", ""));
                else i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(to))).putExtra("sms_body", a.optString("text", ""));
                c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                record(tool, kind + " to " + to, "opened");
                o.put("ok", true);
                o.put("note", "Opened a draft. Nothing is sent or dialled until the user (or a confirmed tap) does it.");
                return o;
            }
            case "open_settings": {
                String page = a.optString("page", "");
                String action;
                switch (page) {
                    case "wifi": action = Settings.ACTION_WIFI_SETTINGS; break;
                    case "bluetooth": action = Settings.ACTION_BLUETOOTH_SETTINGS; break;
                    case "display": action = Settings.ACTION_DISPLAY_SETTINGS; break;
                    case "sound": action = Settings.ACTION_SOUND_SETTINGS; break;
                    case "battery": action = Intent.ACTION_POWER_USAGE_SUMMARY; break;
                    case "apps": action = Settings.ACTION_APPLICATION_SETTINGS; break;
                    case "location": action = Settings.ACTION_LOCATION_SOURCE_SETTINGS; break;
                    case "notifications": action = Settings.ACTION_APP_NOTIFICATION_SETTINGS; break;
                    case "dnd": action = Settings.ACTION_ZEN_MODE_PRIORITY_SETTINGS; break;
                    default: action = Settings.ACTION_SETTINGS;
                }
                c.startActivity(new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                record(tool, "open settings " + page, "ok");
                o.put("ok", true);
                return o;
            }
            case "notifications": {
                o.put("recent", hands().recentNotifications());
                return o;
            }
            case "clipboard": {
                ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
                if (a.has("text")) {
                    cm.setPrimaryClip(ClipData.newPlainText("Skiff", a.getString("text")));
                    o.put("ok", true);
                } else {
                    ClipData d = cm.getPrimaryClip();
                    o.put("text", d != null && d.getItemCount() > 0 && d.getItemAt(0).coerceToText(c) != null ? d.getItemAt(0).coerceToText(c).toString() : "");
                }
                return o;
            }
            case "back_to_skiff": {
                c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
                o.put("ok", true);
                return o;
            }
            case "log": {
                o.put("actions", log());
                return o;
            }
        }
        return err("Unknown phone tool: " + tool);
    }

    static boolean isSystemApp(ApplicationInfo ai) { return (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0; }
}
