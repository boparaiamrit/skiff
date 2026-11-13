package com.navree.skiff;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.SweepGradient;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;

/**
 * The floating bubble's look: a dark disc with the assistant's
 * green → cyan → violet ring and a soft glow. The ring turns while Claude
 * is working.
 */
class RingView extends FrameLayout {
    private static final int[] COLORS = { Color.parseColor("#3dff8f"), Color.parseColor("#3dd6ff"), Color.parseColor("#a78bfa"), Color.parseColor("#3dff8f") };
    private final Paint core = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Matrix m = new Matrix();
    private SweepGradient shader;
    private float angle;
    private ValueAnimator spin;
    private final float density;

    RingView(Context c) {
        super(c);
        density = c.getResources().getDisplayMetrics().density;
        setWillNotDraw(false);
        setLayerType(View.LAYER_TYPE_SOFTWARE, null); // the glow's blur needs a software layer
        core.setColor(Color.parseColor("#121a15"));
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(3 * density);
        glow.setStyle(Paint.Style.STROKE);
        glow.setStrokeWidth(5 * density);
        glow.setAlpha(150);
        glow.setMaskFilter(new BlurMaskFilter(6 * density, BlurMaskFilter.Blur.NORMAL));
    }

    /** Radius of the dark disc; the ring and its glow fit inside the view. */
    float coreRadius() { return Math.min(getWidth(), getHeight()) / 2f - 11 * density; }

    @Override protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        shader = new SweepGradient(w / 2f, h / 2f, COLORS, null);
        ring.setShader(shader);
        glow.setShader(shader);
    }

    @Override protected void onDraw(Canvas c) {
        float cx = getWidth() / 2f, cy = getHeight() / 2f, r = coreRadius();
        if (shader != null) {
            m.setRotate(angle, cx, cy);
            shader.setLocalMatrix(m);
        }
        c.drawCircle(cx, cy, r + 1.5f * density, glow);
        c.drawCircle(cx, cy, r, core);
        c.drawCircle(cx, cy, r + 1.5f * density, ring);
        super.onDraw(c);
    }

    void setBusy(boolean busy) {
        if (busy && spin == null) {
            spin = ValueAnimator.ofFloat(0f, 360f);
            spin.setDuration(1400);
            spin.setRepeatCount(ValueAnimator.INFINITE);
            spin.setInterpolator(new LinearInterpolator());
            spin.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                @Override public void onAnimationUpdate(ValueAnimator a) { angle = (Float) a.getAnimatedValue(); invalidate(); }
            });
            spin.start();
            glow.setAlpha(220);
        } else if (!busy && spin != null) {
            spin.cancel();
            spin = null;
            glow.setAlpha(150);
            invalidate();
        }
    }

    @Override protected void onDetachedFromWindow() {
        if (spin != null) spin.cancel();
        spin = null;
        super.onDetachedFromWindow();
    }
}
