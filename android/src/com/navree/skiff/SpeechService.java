package com.navree.skiff;

import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * Android requires every digital assistant to name a speech recognition
 * service. Skiff's forwards to the phone's real recognizer (Google's or
 * Samsung's), so voice typing elsewhere keeps working.
 */
public class SpeechService extends RecognitionService {
    private SpeechRecognizer inner;

    @Override protected void onStartListening(Intent intent, final Callback cb) {
        if (inner != null) inner.destroy();
        inner = Recognizers.create(this, false);
        if (inner == null) {
            try { cb.error(SpeechRecognizer.ERROR_CLIENT); } catch (Exception ignored) {}
            return;
        }
        inner.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle b) { try { cb.readyForSpeech(b); } catch (Exception ignored) {} }
            @Override public void onBeginningOfSpeech() { try { cb.beginningOfSpeech(); } catch (Exception ignored) {} }
            @Override public void onRmsChanged(float db) { try { cb.rmsChanged(db); } catch (Exception ignored) {} }
            @Override public void onBufferReceived(byte[] buf) { try { cb.bufferReceived(buf); } catch (Exception ignored) {} }
            @Override public void onEndOfSpeech() { try { cb.endOfSpeech(); } catch (Exception ignored) {} }
            @Override public void onError(int code) { try { cb.error(code); } catch (Exception ignored) {} }
            @Override public void onResults(Bundle b) { try { cb.results(b); } catch (Exception ignored) {} }
            @Override public void onPartialResults(Bundle b) { try { cb.partialResults(b); } catch (Exception ignored) {} }
            @Override public void onEvent(int type, Bundle b) {}
        });
        inner.startListening(intent);
    }

    @Override protected void onStopListening(Callback cb) { if (inner != null) inner.stopListening(); }

    @Override protected void onCancel(Callback cb) { if (inner != null) inner.cancel(); }

    @Override public void onDestroy() {
        if (inner != null) inner.destroy();
        inner = null;
        super.onDestroy();
    }
}
