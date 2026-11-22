package com.xiaoxianggu.videocall;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ImageView;
import android.widget.TextView;

final class ScreenShareFloatingBall {
    private static final long THUMBNAIL_DISPLAY_MS = 5000;
    private final Context context;
    private final WindowManager windowManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable returnToCall;
    private final Runnable captureFrame;
    private final int diameter;
    private final WindowManager.LayoutParams params;
    private LinearLayout root;
    private LinearLayout actions;
    private TextView statusView;
    private ImageView thumbnailView;
    private boolean expanded;
    private boolean closed;
    private String status = "共享中";
    private String visualStatus;
    private String callStatus;
    private int visualImageCount;
    private int visualImageLimit;
    private byte[] thumbnail;
    private Runnable thumbnailExpiry;

    ScreenShareFloatingBall(Context context, Runnable returnToCall, Runnable captureFrame) {
        this.context = context.getApplicationContext();
        this.windowManager = this.context.getSystemService(WindowManager.class);
        this.returnToCall = returnToCall;
        this.captureFrame = captureFrame;
        this.diameter = dp(56);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        this.params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.END;
        params.x = dp(16);
        params.y = dp(144);
    }

    void show() {
        if (closed || root != null || !Settings.canDrawOverlays(context)) return;
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setGravity(Gravity.END);

        if (thumbnail != null) {
            LinearLayout card = new LinearLayout(context);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(6), dp(6), dp(6), dp(6));
            card.setBackground(background(0xEE292B35, false));
            card.setElevation(dp(6));
            Bitmap bitmap = decodeThumbnail();
            if (bitmap != null) {
                thumbnailView = new ImageView(context);
                thumbnailView.setImageBitmap(bitmap);
                thumbnailView.setScaleType(ImageView.ScaleType.CENTER_CROP);
                card.addView(thumbnailView, new LinearLayout.LayoutParams(dp(152), dp(88)));
            }
            LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(dp(164), WindowManager.LayoutParams.WRAP_CONTENT);
            cardParams.bottomMargin = dp(6);
            view.addView(card, cardParams);
        }

        TextView ball = new TextView(context);
        ball.setText(visualBallLabel(displayStatus()));
        ball.setTextSize(11);
        ball.setTextColor(Color.WHITE);
        ball.setGravity(Gravity.CENTER);
        ball.setMaxLines(2);
        ball.setContentDescription(statusDescription());
        ball.setBackground(background(Color.rgb(57, 72, 131), true));
        ball.setElevation(dp(6));
        ball.setOnClickListener(ignored -> toggleActions());
        ball.setLayoutParams(new LinearLayout.LayoutParams(diameter, diameter));
        LinearLayout actionView = new LinearLayout(context);
        actionView.setOrientation(LinearLayout.VERTICAL);
        actionView.setGravity(Gravity.END);
        actionView.addView(ball);
        view.addView(actionView);
        actions = actionView;
        statusView = ball;

        int touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        float[] down = new float[2];
        int[] start = new int[2];
        boolean[] dragged = new boolean[1];
        ball.setOnTouchListener((touched, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    down[0] = event.getRawX();
                    down[1] = event.getRawY();
                    start[0] = params.x;
                    start[1] = params.y;
                    dragged[0] = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = event.getRawX() - down[0];
                    float dy = event.getRawY() - down[1];
                    if (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop) dragged[0] = true;
                    if (dragged[0]) {
                        params.x = Math.max(0, Math.min(start[0] - (int) dx,
                            context.getResources().getDisplayMetrics().widthPixels - diameter));
                        params.y = Math.max(0, Math.min(start[1] + (int) dy,
                            context.getResources().getDisplayMetrics().heightPixels - diameter));
                        try { windowManager.updateViewLayout(view, params); }
                        catch (RuntimeException ignored) { hide(); }
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!dragged[0]) touched.performClick();
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    return true;
                default:
                    return false;
            }
        });

        root = view;
        try {
            windowManager.addView(view, params);
        } catch (RuntimeException ignored) {
            root = null;
            statusView = null;
        }
    }

    boolean hide() {
        LinearLayout view = root;
        if (view != null) {
            try { windowManager.removeViewImmediate(view); }
            catch (RuntimeException ignored) { return false; }
        }
        root = null;
        actions = null;
        statusView = null;
        thumbnailView = null;
        return true;
    }

    void close() {
        closed = true;
        if (thumbnailExpiry != null) mainHandler.removeCallbacks(thumbnailExpiry);
        thumbnailExpiry = null;
        hide();
    }

    void setStatus(String status) {
        this.status = status == null || status.trim().isEmpty() ? "共享中" : status;
        renderStatus();
    }

    void setCallStatus(String status) {
        callStatus = status == null || status.trim().isEmpty() ? null : status.trim();
        renderStatus();
    }

    void setVisualStatus(String status) {
        visualStatus = status == null || status.trim().isEmpty() ? "画面状态未知" : status;
        renderStatus();
    }

    void setVisualImageCount(int imageCount, int maxImages) {
        visualImageCount = imageCount;
        visualImageLimit = maxImages;
        renderStatus();
        if (expanded) updateActions();
    }

    private String displayStatus() {
        if (visualStatus != null && (visualStatus.contains("失败") || visualStatus.contains("上限")
            || visualStatus.contains("正在截图"))) return visualStatus;
        if (callStatus != null) return callStatus;
        return visualStatus == null ? status : visualStatus;
    }

    private String statusDescription() {
        StringBuilder description = new StringBuilder();
        if (callStatus != null) description.append("通话：").append(callStatus);
        if (visualStatus != null) {
            if (description.length() > 0) description.append("；");
            description.append("画面：").append(visualStatus);
        }
        if (description.length() == 0) description.append("屏幕共享中，点按展开操作");
        if (visualImageCount > 0) description.append("；截图 ").append(visualImageCount).append('/').append(visualImageLimit);
        return description.toString();
    }

    private void renderStatus() {
        if (statusView == null) return;
        statusView.setText(visualBallLabel(displayStatus()));
        statusView.setContentDescription(statusDescription());
    }

    private String visualBallLabel(String value) {
        if (value == null) return status;
        String label = value;
        if (value.contains("截图失败")) label = "截图失败";
        else if (value.contains("发送失败")) label = "发送失败";
        else if (value.contains("上限")) label = "已达上限";
        else if (value.contains("正在截图")) label = "截图中";
        else if (value.contains("重连")) label = "ASR重连";
        else if (value.contains("消息已排队") || value.contains("等待 MCP")) label = "等待MCP";
        else if (value.contains("已送达桥接") || value.contains("等待 AI")) label = "等待AI";
        else if (value.contains("AI 已收到") || value.contains("等待回覆")) label = "等待回复";
        else if (value.contains("思考中")) label = "思考中";
        else if (value.contains("語音合成")) label = "合成中";
        else if (value.contains("传送中") || value.contains("傳送中")) label = "发送中";
        else if (value.contains("聆聽中")) label = "聆听中";
        else if (value.contains("已截图") || value.contains("等待说话")) label = "等待说话";
        else if (value.contains("未识别到文字")) label = "等待说话";
        else if (value.contains("等待语音") || value.contains("最终分句")) label = "等语音";
        else if (value.contains("正在听")) label = "正在听";
        else if (value.contains("发送中")) label = "发送中";
        else if (value.contains("已发送")) label = "已发送";
        return visualImageCount > 0 ? visualImageCount + "/" + visualImageLimit + "\n" + label : label;
    }

    void setVisualFeedback(String status, byte[] jpeg) {
        setVisualStatus(status);
        if (jpeg != null) {
            if (thumbnailExpiry != null) mainHandler.removeCallbacks(thumbnailExpiry);
            thumbnail = jpeg.clone();
            byte[] shownThumbnail = thumbnail;
            thumbnailExpiry = () -> {
                thumbnailExpiry = null;
                if (thumbnail != shownThumbnail) return;
                thumbnail = null;
                refresh();
            };
            mainHandler.postDelayed(thumbnailExpiry, THUMBNAIL_DISPLAY_MS);
        }
        refresh();
    }

    void clearVisualFeedback() {
        if (thumbnailExpiry != null) mainHandler.removeCallbacks(thumbnailExpiry);
        thumbnailExpiry = null;
        visualStatus = null;
        visualImageCount = 0;
        visualImageLimit = 0;
        thumbnail = null;
        refresh();
    }

    private void refresh() {
        if (root == null) return;
        hide();
        show();
        if (expanded) updateActions();
    }

    private void toggleActions() {
        if (actions == null) return;
        expanded = !expanded;
        updateActions();
    }

    private void updateActions() {
        if (actions == null) return;
        actions.removeViews(1, Math.max(0, actions.getChildCount() - 1));
        if (expanded) {
            actions.addView(action("返回通话", () -> {
                expanded = false;
                returnToCall.run();
            }));
            if (visualImageLimit <= 0 || visualImageCount < visualImageLimit) {
                actions.addView(action("发送画面", () -> {
                    if (visualImageLimit > 0 && visualImageCount >= visualImageLimit) {
                        setVisualStatus("已达到 " + visualImageLimit + " 张截图上限");
                        return;
                    }
                    expanded = false;
                    captureFrame.run();
                }));
            }
        }
        try { windowManager.updateViewLayout(root, params); }
        catch (RuntimeException ignored) { hide(); }
    }

    private TextView action(String label, Runnable callback) {
        TextView button = new TextView(context);
        button.setText(label);
        button.setTextSize(14);
        button.setTextColor(Color.WHITE);
        button.setGravity(Gravity.CENTER);
        button.setContentDescription(label);
        button.setPadding(dp(10), 0, dp(10), 0);
        button.setBackground(background(0xEE292B35, false));
        button.setElevation(dp(6));
        button.setOnClickListener(ignored -> {
            toggleActions();
            callback.run();
        });
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(dp(132), dp(44));
        layout.topMargin = dp(6);
        button.setLayoutParams(layout);
        return button;
    }

    private Bitmap decodeThumbnail() {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(thumbnail, 0, thumbnail.length, bounds);
        int targetWidth = dp(152);
        int targetHeight = dp(88);
        int sampleSize = 1;
        while (bounds.outWidth / (sampleSize * 2) >= targetWidth
            && bounds.outHeight / (sampleSize * 2) >= targetHeight) {
            sampleSize *= 2;
        }
        BitmapFactory.Options decode = new BitmapFactory.Options();
        decode.inSampleSize = sampleSize;
        return BitmapFactory.decodeByteArray(thumbnail, 0, thumbnail.length, decode);
    }

    private GradientDrawable background(int color, boolean circle) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(circle ? diameter : dp(12));
        drawable.setStroke(dp(1), 0xCCFFFFFF);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
