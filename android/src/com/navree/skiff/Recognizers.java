package com.navree.skiff;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.provider.Settings;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

import java.util.List;

/** Picks a speech recognizer that is not Skiff's own (which only forwards). */
final class Recognizers {
    private Recognizers() {}

    static boolean offlineAvailable(Context c) {
        try {
            return Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(c);
        } catch (Exception e) {
            return false;
        }
    }

    static SpeechRecognizer create(Context c, boolean offline) {
        if (offline && offlineAvailable(c)) return SpeechRecognizer.createOnDeviceSpeechRecognizer(c);
        String def = Settings.Secure.getString(c.getContentResolver(), "voice_recognition_service");
        if (def == null || !def.startsWith(c.getPackageName() + "/")) return SpeechRecognizer.createSpeechRecognizer(c);
        ComponentName other = pick(c);
        return other != null ? SpeechRecognizer.createSpeechRecognizer(c, other) : SpeechRecognizer.createSpeechRecognizer(c);
    }

    /** Google's recognizer if installed, then Samsung's, then any other. */
    static ComponentName pick(Context c) {
        List<ResolveInfo> list = c.getPackageManager().queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0);
        ComponentName best = null;
        int bestScore = -1;
        for (ResolveInfo r : list) {
            String pkg = r.serviceInfo.packageName;
            if (pkg.equals(c.getPackageName())) continue;
            int score = pkg.startsWith("com.google.") ? 3 : pkg.startsWith("com.samsung.") ? 2 : 1;
            if (score > bestScore) {
                bestScore = score;
                best = new ComponentName(pkg, r.serviceInfo.name);
            }
        }
        return best;
    }
}
