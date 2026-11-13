package com.navree.skiff;

import android.content.Context;

/** What the JavaScript bridge needs from the window it lives in: the app or the bubble. */
interface Host {
    Context context();
    void runOnUi(Runnable r);
    void openExternal(String url);
    Voice voice();
    void requestPermissions(String[] perms, int code);
    void reloadWhenReady();
    void minimize();
    void openApp();
    void setBadge(String kind);
    boolean isBubble();
}
