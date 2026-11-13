package com.navree.skiff;

import android.content.Context;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * A tiny HTTP server on 127.0.0.1 that skiffd calls to run phone tools.
 * Every request must carry the launch token.
 */
public class PhoneServer implements Runnable {
    static volatile int port;
    private final Context ctx;
    private ServerSocket ss;

    PhoneServer(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    void start() throws Exception {
        ss = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        port = ss.getLocalPort();
        Thread t = new Thread(this, "phone-server");
        t.setDaemon(true);
        t.start();
        AppLog.i("phone server on port " + port);
    }

    void stop() { try { if (ss != null) ss.close(); } catch (Exception ignored) {} }

    @Override public void run() {
        while (!ss.isClosed()) {
            try {
                final Socket s = ss.accept();
                new Thread(new Runnable() { @Override public void run() { handle(s); } }, "phone-call").start();
            } catch (Exception e) {
                if (!ss.isClosed()) AppLog.i("phone server: " + e);
            }
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(180000);
            java.io.InputStream in = s.getInputStream();
            // read the header block byte by byte up to the blank line
            java.io.ByteArrayOutputStream hb = new java.io.ByteArrayOutputStream();
            int b, state = 0;
            while (state < 4 && (b = in.read()) >= 0) {
                hb.write(b);
                state = (b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3)) ? state + 1 : (b == '\r' ? 1 : 0);
                if (hb.size() > 16384) break;
            }
            String[] lines = hb.toString("UTF-8").split("\r\n");
            String first = lines.length > 0 ? lines[0] : null;
            int len = 0;
            String token = "";
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c < 0) continue;
                String k = lines[i].substring(0, c).trim().toLowerCase();
                String v = lines[i].substring(c + 1).trim();
                if (k.equals("content-length")) len = Integer.parseInt(v);
                if (k.equals("x-skiff-token")) token = v;
            }
            byte[] body = new byte[Math.max(0, Math.min(len, 8 << 20))];
            int off = 0;
            while (off < body.length) {
                int n = in.read(body, off, body.length - off);
                if (n < 0) break;
                off += n;
            }
            JSONObject res;
            int code = 200;
            String t = SkiffService.token;
            if (t == null || !t.equals(token)) {
                code = 401;
                res = new JSONObject().put("error", "unauthorized");
            } else if (first == null || !first.startsWith("POST /call")) {
                code = 404;
                res = new JSONObject().put("error", "not found");
            } else {
                res = Phone.call(ctx, new JSONObject(new String(body, 0, off, StandardCharsets.UTF_8)));
            }
            byte[] out = res.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = s.getOutputStream();
            os.write(("HTTP/1.1 " + code + " OK\r\nContent-Type: application/json\r\nContent-Length: " + out.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            os.write(out);
            os.flush();
        } catch (Exception e) {
            AppLog.i("phone call failed: " + e);
        } finally {
            try { s.close(); } catch (Exception ignored) {}
        }
    }
}
