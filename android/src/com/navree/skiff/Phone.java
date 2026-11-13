package com.navree.skiff;

import android.content.ComponentName;
import android.content.Context;
import android.provider.Settings;
import android.text.TextUtils;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Entry point for phone tools: steps the bubble aside, then runs the tool. */
final class Phone {
    // tools that only look or listen: the bubble can stay where it is
    private static final Set<String> LOOK = new HashSet<>(Arrays.asList(
            "status", "read_screen", "wait_for", "list_apps", "notifications", "clipboard", "log", "media", "unlock"));

    private Phone() {}

    static JSONObject call(Context c, JSONObject req) {
        if (!LOOK.contains(req.optString("tool"))) {
            Bubble.collapseForAction();
            AssistSession.collapseForAction();
        }
        return PhoneTools.call(c, req);
    }

    /** Whether the user switched Skiff phone control on in Accessibility settings. */
    static boolean enabledInSettings(Context c) {
        String list = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(list)) return false;
        ComponentName me = new ComponentName(c, SkiffHands.class);
        for (String s : list.split(":")) {
            if (me.equals(ComponentName.unflattenFromString(s))) return true;
        }
        return false;
    }

    /** {on, enabledInSettings, policy, stopped, log} for the Setup screen. */
    static JSONObject state(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("on", SkiffHands.get() != null);
            o.put("enabledInSettings", enabledInSettings(c));
            o.put("policy", PhoneTools.policy(c));
            o.put("stopped", PhoneTools.stopped);
            o.put("log", PhoneTools.log());
        } catch (Exception ignored) {}
        return o;
    }
}
