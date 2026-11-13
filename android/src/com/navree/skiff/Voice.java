package com.navree.skiff;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Phone speech recognition and text-to-speech for the chat's voice input
 * and voice mode. Results go to the page as window.skiffVoice({...}).
 */
public class Voice {
    static final int REQ_MIC = 9;
    private final Host host;
    private final WebView web;
    private SpeechRecognizer rec;
    private boolean recOffline;
    private TextToSpeech tts;
    private boolean ttsReady;
    // While we listen, other audio (music, videos) pauses so the recognizer
    // hears only your voice; it resumes when we let go.
    private AudioManager am;
    private AudioFocusRequest focusReq;
    private boolean focused, pinned;

    Voice(Host host, WebView web) {
        this.host = host;
        this.web = web;
    }

    private void emit(String type, String key, Object value) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (key != null) o.put(key, value);
            final String js = "window.skiffVoice && window.skiffVoice(" + o.toString() + ")";
            host.runOnUi(new Runnable() {
                @Override public void run() { if (web != null) web.evaluateJavascript(js, null); }
            });
        } catch (Exception ignored) {
        }
    }

    boolean hasMic() {
        return host.context().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    void requestMic() {
        host.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
    }

    boolean available() { return SpeechRecognizer.isRecognitionAvailable(host.context()); }

    private void focus(boolean on) {
        try {
            if (am == null) am = (AudioManager) host.context().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (on && !focused) {
                AudioAttributes aa = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
                focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                        .setAudioAttributes(aa)
                        .setOnAudioFocusChangeListener(new AudioManager.OnAudioFocusChangeListener() {
                            @Override public void onAudioFocusChange(int change) {}
                        }).build();
                focused = am.requestAudioFocus(focusReq) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            } else if (!on && focused) {
                am.abandonAudioFocusRequest(focusReq);
                focused = false;
            }
        } catch (Exception e) {
            AppLog.i("audio focus: " + e);
        }
    }

    /** Keep other audio paused for a whole conversation (voice mode, the assistant). */
    void pin(boolean on) {
        pinned = on;
        focus(on);
    }

    private void release() { if (!pinned) focus(false); }

    /** Must run on the UI thread. */
    void start(String lang) { start(lang, false); }

    /** offline: use the phone's on-device recognizer (no internet needed for speech). */
    void start(String lang, boolean offline) {
        if (!hasMic()) {
            requestMic();
            emit("error", "error", "permission");
            return;
        }
        if (offline && !Recognizers.offlineAvailable(host.context())) offline = false;
        if (!offline && !available()) {
            emit("error", "error", "unavailable");
            return;
        }
        if (rec != null && recOffline != offline) { rec.destroy(); rec = null; }
        if (rec == null) {
            recOffline = offline;
            rec = Recognizers.create(host.context(), offline);
            rec.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) { emit("ready", null, null); }
                @Override public void onBeginningOfSpeech() { emit("speech", null, null); }
                @Override public void onRmsChanged(float db) { emit("level", "db", db); }
                @Override public void onBufferReceived(byte[] buf) {}
                @Override public void onEndOfSpeech() { emit("end", null, null); }
                @Override public void onError(int code) { release(); emit("error", "error", String.valueOf(code)); }
                @Override public void onResults(Bundle b) { release(); emit("final", "text", first(b)); }
                @Override public void onPartialResults(Bundle b) { emit("partial", "text", first(b)); }
                @Override public void onEvent(int t, Bundle b) {}
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1800);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
        if (lang != null && lang.length() > 0) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        focus(true);
        try {
            rec.startListening(i);
        } catch (Exception e) {
            emit("error", "error", e.toString());
        }
    }

    void stop() { if (rec != null) rec.stopListening(); }

    void cancel() {
        if (rec != null) rec.cancel();
        release();
    }

    private static String first(Bundle b) {
        ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r != null && !r.isEmpty() ? r.get(0) : "";
    }

    void speak(final String text, final String lang) {
        if (tts == null) {
            tts = new TextToSpeech(host.context(), new TextToSpeech.OnInitListener() {
                @Override public void onInit(int status) {
                    ttsReady = status == TextToSpeech.SUCCESS;
                    if (ttsReady) speakNow(text, lang);
                    else emit("tts-done", null, null);
                }
            });
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { emit("tts-start", null, null); }
                @Override public void onDone(String id) { if ("last".equals(id)) emit("tts-done", null, null); }
                @Override public void onError(String id) { emit("tts-done", null, null); }
            });
            return;
        }
        if (ttsReady) speakNow(text, lang);
    }

    private void speakNow(String text, String lang) {
        if (lang != null && lang.length() > 0) tts.setLanguage(Locale.forLanguageTag(lang));
        // TextToSpeech has an input limit; speak long replies in chunks
        int max = Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 50);
        ArrayList<String> parts = new ArrayList<>();
        String rest = text;
        while (rest.length() > max) {
            int cut = rest.lastIndexOf(". ", max);
            if (cut < max / 2) cut = max;
            parts.add(rest.substring(0, cut + 1));
            rest = rest.substring(cut + 1);
        }
        parts.add(rest);
        for (int n = 0; n < parts.size(); n++) {
            tts.speak(parts.get(n), n == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, null, n == parts.size() - 1 ? "last" : "p" + n);
        }
    }

    void stopSpeaking() { if (tts != null) tts.stop(); }

    void destroy() {
        pinned = false;
        focus(false);
        if (rec != null) rec.destroy();
        if (tts != null) tts.shutdown();
    }
}
