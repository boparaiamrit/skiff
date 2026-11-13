package com.navree.skiff;

import android.app.Activity;
import android.app.KeyguardManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import java.util.concurrent.CountDownLatch;

/**
 * Shows Android's own unlock prompt (fingerprint, face or PIN) when Claude
 * needs the phone unlocked to continue, for example after the assistant was
 * opened on the lock screen. Skiff never sees the PIN.
 */
public class UnlockActivity extends Activity {
    static volatile CountDownLatch latch;
    static volatile boolean unlocked;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (km == null || !km.isKeyguardLocked()) { done(true); return; }
        km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
            @Override public void onDismissSucceeded() { done(true); }
            @Override public void onDismissCancelled() { done(false); }
            @Override public void onDismissError() { done(false); }
        });
    }

    private void done(boolean ok) {
        unlocked = ok;
        CountDownLatch l = latch;
        if (l != null) l.countDown();
        finish();
        overridePendingTransition(0, 0);
    }
}
