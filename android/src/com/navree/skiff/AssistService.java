package com.navree.skiff;

import android.os.Bundle;
import android.service.voice.VoiceInteractionService;

/**
 * Makes Skiff selectable as the phone's digital assistant (Settings →
 * Default apps → Digital assistant app). Once chosen, the side button,
 * the assistant gesture and long-press home open an {@link AssistSession}.
 */
public class AssistService extends VoiceInteractionService {
    private static volatile AssistService instance;

    @Override public void onReady() {
        super.onReady();
        instance = this;
        AppLog.i("assistant: ready");
    }

    @Override public void onShutdown() {
        instance = null;
        super.onShutdown();
    }

    /** Opens the assistant as if the side button was held (only while Skiff is the assistant). */
    static boolean show() {
        AssistService s = instance;
        if (s == null) return false;
        s.showSession(new Bundle(), 0);
        return true;
    }
}
