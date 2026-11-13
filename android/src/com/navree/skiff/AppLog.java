package com.navree.skiff;

import android.util.Log;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/** A small in-memory log the user can copy from the app when something breaks. */
public final class AppLog {
    private static final ArrayDeque<String> LINES = new ArrayDeque<>();
    private static final SimpleDateFormat FMT = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US);

    private AppLog() {}

    public static synchronized void i(String msg) {
        Log.i("Skiff", msg);
        LINES.addLast(FMT.format(new Date()) + " " + msg);
        while (LINES.size() > 800) LINES.removeFirst();
    }

    public static synchronized String dump() {
        StringBuilder sb = new StringBuilder();
        for (String l : LINES) sb.append(l).append('\n');
        return sb.toString();
    }
}
