package com.navree.skiff;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;

/**
 * Keeps the skiffd backend (a static Linux binary shipped as libskiffd.so)
 * running as a foreground service, so terminals and Claude sessions survive
 * when the app is in the background.
 */
public class SkiffService extends Service {
    public static final String ACTION_STOP = "com.navree.skiff.STOP";
    public static final String ACTION_RESTART = "com.navree.skiff.RESTART";
    private static final String CHANNEL = "skiff";

    public static volatile int port;
    public static volatile String token;
    public static volatile boolean running;
    private static SkiffService instance;

    private Process proc;
    private PhoneServer phone;
    private volatile boolean stopping;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private int restarts;
    private long firstRestart;

    public static SkiffService get() { return instance; }

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, SkiffService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Context.class.getMethod("startForegroundService", Intent.class).invoke(ctx, i);
                return;
            } catch (Exception e) {
                AppLog.i("startForegroundService failed: " + e);
            }
        }
        ctx.startService(i);
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        startForeground(1, buildNotification());
        try {
            phone = new PhoneServer(this);
            phone.start();
        } catch (Exception e) {
            AppLog.i("phone server failed: " + e);
        }
        if (prefs().getBoolean("keepAwake", false)) setKeepAwake(true);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            AppLog.i("stop requested from notification");
            shutdown();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_RESTART.equals(action)) {
            restartBackend();
        } else if (proc == null) {
            launch();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        Bubble.stop();
        if (phone != null) phone.stop();
        shutdown();
        instance = null;
        super.onDestroy();
    }

    private SharedPreferences prefs() { return getSharedPreferences("skiff", MODE_PRIVATE); }

    private synchronized void launch() {
        stopping = false;
        try {
            if (port == 0) {
                // Keep the same port across launches: the UI's saved state
                // (current chat, project, settings) belongs to this address.
                int saved = prefs().getInt("port", 37321);
                port = portFree(saved) ? saved : 0;
                if (port == 0) {
                    ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
                    port = s.getLocalPort();
                    s.close();
                }
                prefs().edit().putInt("port", port).apply();
            }
            if (token == null) {
                byte[] b = new byte[16];
                new SecureRandom().nextBytes(b);
                StringBuilder sb = new StringBuilder();
                for (byte x : b) sb.append(String.format("%02x", x));
                token = sb.toString();
            }
            String nativeDir = getApplicationInfo().nativeLibraryDir;
            File bin = new File(nativeDir, "libskiffd.so");
            File home = getFilesDir();
            new File(home, "tmp").mkdirs();
            ProcessBuilder pb = new ProcessBuilder(bin.getAbsolutePath());
            Map<String, String> env = pb.environment();
            env.put("SKIFF_HOME", home.getAbsolutePath());
            env.put("SKIFF_PORT", String.valueOf(port));
            env.put("SKIFF_TOKEN", token);
            env.put("SKIFF_ANDROID", "1");
            env.put("SKIFF_NATIVE_DIR", nativeDir);
            env.put("SKIFF_DNS", dnsServers());
            env.put("SKIFF_PHONE_PORT", String.valueOf(PhoneServer.port));
            env.put("HOME", home.getAbsolutePath());
            env.put("TMPDIR", new File(home, "tmp").getAbsolutePath());
            pb.directory(home);
            pb.redirectErrorStream(true);
            AppLog.i("starting backend " + bin + " on port " + port);
            final Process p = pb.start();
            proc = p;
            running = true;
            new Thread(new Runnable() {
                @Override public void run() { pump(p); }
            }, "skiffd-log").start();
            Bubble.ensure(this);
        } catch (Exception e) {
            AppLog.i("failed to start backend: " + e);
            running = false;
        }
    }

    private static boolean portFree(int p) {
        try {
            ServerSocket s = new ServerSocket(p, 1, InetAddress.getByName("127.0.0.1"));
            s.close();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void pump(Process p) {
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String line;
            while ((line = r.readLine()) != null) AppLog.i("skiffd: " + line);
        } catch (Exception ignored) {
        }
        int code = -1;
        try { code = p.waitFor(); } catch (InterruptedException ignored) {}
        AppLog.i("backend exited with code " + code);
        synchronized (this) {
            if (proc == p) { proc = null; running = false; }
        }
        if (!stopping) {
            long now = System.currentTimeMillis();
            if (now - firstRestart > 60000) { firstRestart = now; restarts = 0; }
            if (++restarts <= 5) {
                try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
                AppLog.i("restarting backend (" + restarts + ")");
                launch();
            } else {
                AppLog.i("backend keeps crashing; not restarting");
            }
        }
    }

    public synchronized void restartBackend() {
        stopping = true;
        killBackend();
        restarts = 0;
        launch();
    }

    private void killBackend() {
        Process p = proc;
        proc = null;
        running = false;
        if (p == null) return;
        // ask skiffd to close its terminals and Claude processes cleanly
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/shutdown").openConnection();
                    c.setRequestMethod("POST");
                    c.setRequestProperty("X-Skiff-Token", token);
                    c.setConnectTimeout(800);
                    c.setReadTimeout(1500);
                    c.setDoOutput(true);
                    OutputStream o = c.getOutputStream();
                    o.write("{}".getBytes());
                    o.close();
                    c.getResponseCode();
                    c.disconnect();
                    Thread.sleep(400);
                } catch (Exception ignored) {
                }
            }
        });
        t.start();
        try { t.join(2500); } catch (InterruptedException ignored) {}
        p.destroy();
    }

    private void shutdown() {
        stopping = true;
        killBackend();
        setKeepAwake(false);
    }

    private String dnsServers() {
        StringBuilder sb = new StringBuilder();
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            LinkProperties lp = n != null ? cm.getLinkProperties(n) : null;
            if (lp != null) {
                List<InetAddress> list = lp.getDnsServers();
                for (InetAddress a : list) {
                    String h = a.getHostAddress();
                    int pct = h.indexOf('%');
                    if (pct >= 0) h = h.substring(0, pct);
                    if (sb.length() > 0) sb.append(',');
                    sb.append(h);
                }
            }
        } catch (Exception e) {
            AppLog.i("dns lookup failed: " + e);
        }
        return sb.toString();
    }

    public boolean isKeepAwake() { return wakeLock != null && wakeLock.isHeld(); }

    public void setKeepAwake(boolean on) {
        prefs().edit().putBoolean("keepAwake", on).apply();
        try {
            if (on && !isKeepAwake()) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "skiff:work");
                wakeLock.acquire();
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "skiff:wifi");
                wifiLock.acquire();
            } else if (!on) {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
                wakeLock = null;
                wifiLock = null;
            }
        } catch (Exception e) {
            AppLog.i("wake lock: " + e);
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(1, buildNotification());
    }

    /** A heads-up notification when Claude is waiting for the user. */
    public void notifyAttention(String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                Class<?> chClass = Class.forName("android.app.NotificationChannel");
                Object ch = chClass.getConstructor(String.class, CharSequence.class, int.class)
                        .newInstance("attention", "Claude needs you", 4 /* IMPORTANCE_HIGH */);
                NotificationManager.class.getMethod("createNotificationChannel", chClass).invoke(nm, ch);
                b = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(this, "attention");
            } else {
                b = new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            }
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent p = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setAutoCancel(true).setContentIntent(p);
            nm.notify(2, b.build());
        } catch (Exception e) {
            AppLog.i("notify: " + e);
        }
    }

    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Class<?> chClass = Class.forName("android.app.NotificationChannel");
                Object ch = chClass.getConstructor(String.class, CharSequence.class, int.class)
                        .newInstance(CHANNEL, "Skiff running", 2 /* IMPORTANCE_LOW */);
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                NotificationManager.class.getMethod("createNotificationChannel", chClass).invoke(nm, ch);
                b = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(this, CHANNEL);
            } catch (Exception e) {
                b = new Notification.Builder(this);
            }
        } else {
            b = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, SkiffService.class).setAction(ACTION_STOP);
        PendingIntent pStop = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Skiff is running")
                .setContentText(isKeepAwake() ? "Keeping your sessions alive (screen-off work on)" : "Terminals and Claude sessions stay alive in the background")
                .setOngoing(true)
                .setContentIntent(pOpen)
                .addAction(new Notification.Action.Builder(null, "Stop", pStop).build());
        return b.build();
    }
}
