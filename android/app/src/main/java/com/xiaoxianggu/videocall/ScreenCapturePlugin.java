package com.xiaoxianggu.videocall;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.provider.Settings;
import android.media.projection.MediaProjectionManager;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenCapture")
public class ScreenCapturePlugin extends Plugin {
    private BroadcastReceiver visualCaptureReceiver;

    @Override
    public void load() {
        super.load();
        IntentFilter filter = new IntentFilter();
        filter.addAction(ScreenCaptureService.ACTION_VISUAL_CAPTURE_STARTED);
        filter.addAction(ScreenCaptureService.ACTION_VISUAL_CAPTURE_RESULT);
        visualCaptureReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                String action = intent.getAction();
                boolean started = ScreenCaptureService.ACTION_VISUAL_CAPTURE_STARTED.equals(action);
                JSObject payload = new JSObject();
                String roundId = intent.getStringExtra(ScreenCaptureService.EXTRA_VISUAL_ROUND_ID);
                String source = intent.getStringExtra(ScreenCaptureService.EXTRA_VISUAL_SOURCE);
                String status = intent.getStringExtra(ScreenCaptureService.EXTRA_VISUAL_STATUS);
                long generation = intent.getLongExtra(ScreenCaptureService.EXTRA_VISUAL_GENERATION, 0);
                if (roundId != null) payload.put("roundId", roundId);
                payload.put("generation", generation);
                payload.put("source", source == null ? "screen" : source);
                payload.put("status", status == null ? "failed" : status);
                payload.put("width", 0);
                payload.put("height", 0);
                payload.put("bytes", 0);
                if (!started) {
                    if ("ready".equals(status)) {
                        ScreenCaptureService.VisualCapture capture = ScreenCaptureService.readVisualCapture(roundId, generation);
                        if (capture == null) return;
                        payload.put("image", Base64.encodeToString(capture.image, Base64.NO_WRAP));
                        payload.put("width", capture.width);
                        payload.put("height", capture.height);
                        payload.put("bytes", capture.image.length);
                    } else {
                        payload.put("error", "屏幕截图失败");
                    }
                }
                notifyListeners(started ? "visualCaptureStarted" :
                    ("ready".equals(status) ? "visualCaptureReady" : "visualCaptureFailed"), payload, true);
            }
        };
        ContextCompat.registerReceiver(
            getContext(),
            visualCaptureReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (visualCaptureReceiver != null) {
            try { getContext().unregisterReceiver(visualCaptureReceiver); }
            catch (IllegalArgumentException ignored) {}
            visualCaptureReceiver = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (ScreenCaptureService.isActive()) {
            call.resolve(activeResult(true));
            return;
        }
        if (needsOverlayPermission() && !Settings.canDrawOverlays(getContext())) {
            Intent overlaySettings = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())
            );
            try {
                startActivityForResult(call, overlaySettings, "overlayPermissionResult");
            } catch (Exception e) {
                call.reject("无法打开悬浮窗授权设置", e);
            }
            return;
        }
        requestMediaProjection(call);
    }

    @ActivityCallback
    private void overlayPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("需要允许悬浮窗权限才能共享屏幕");
            return;
        }
        if (ScreenCaptureService.isActive()) {
            call.resolve(activeResult(true));
            return;
        }
        requestMediaProjection(call);
    }

    private boolean needsOverlayPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M;
    }

    private void requestMediaProjection(PluginCall call) {
        MediaProjectionManager manager = getContext().getSystemService(MediaProjectionManager.class);
        if (manager == null) {
            call.reject("屏幕共享服务不可用");
            return;
        }
        try {
            startActivityForResult(call, manager.createScreenCaptureIntent(), "screenCaptureResult");
        } catch (Exception e) {
            call.reject("无法请求屏幕共享授权", e);
        }
    }

    @ActivityCallback
    private void screenCaptureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("屏幕共享已取消");
            return;
        }
        Intent service = new Intent(getContext(), ScreenCaptureService.class)
            .setAction(ScreenCaptureService.ACTION_START)
            .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.getResultCode())
            .putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
            .putExtra(ScreenCaptureService.EXTRA_START_RESULT, new ResultReceiver(new Handler(Looper.getMainLooper())) {
                @Override
                protected void onReceiveResult(int resultCode, Bundle resultData) {
                    if (resultCode == ScreenCaptureService.START_RESULT_ACTIVE) {
                        call.resolve(activeResult(true));
                        return;
                    }
                    String message = resultData == null ? null : resultData.getString("message");
                    if (message == null || message.isEmpty()) message = "屏幕共享未能启动";
                    call.reject(message);
                }
            });
        try {
            ContextCompat.startForegroundService(getContext(), service);
        } catch (Exception e) {
            call.reject("屏幕共享未能启动", e);
        }
    }

    @PluginMethod
    public void captureFrame(PluginCall call) {
        byte[] frame = ScreenCaptureService.latestFrame();
        JSObject result = activeResult(ScreenCaptureService.isActive());
        if (frame != null) result.put("image", Base64.encodeToString(frame, Base64.NO_WRAP));
        call.resolve(result);
    }

    @PluginMethod
    public void captureSnapshot(PluginCall call) {
        String roundId = call.getString("roundId");
        ResultReceiver receiver = new ResultReceiver(new Handler(Looper.getMainLooper())) {
            @Override
            protected void onReceiveResult(int resultCode, Bundle data) {
                if (resultCode != ScreenCaptureService.VISUAL_RESULT_READY || data == null) {
                    call.reject("屏幕截图失败");
                    return;
                }
                String roundId = data.getString(ScreenCaptureService.EXTRA_VISUAL_ROUND_ID);
                long generation = data.getLong(ScreenCaptureService.EXTRA_VISUAL_GENERATION, 0);
                ScreenCaptureService.VisualCapture capture = ScreenCaptureService.readVisualCapture(roundId, generation);
                if (capture == null) {
                    call.reject("截图回合已被新的画面替换，请重试");
                    return;
                }
                JSObject result = new JSObject();
                result.put("image", Base64.encodeToString(capture.image, Base64.NO_WRAP));
                result.put("source", data.getString(ScreenCaptureService.EXTRA_VISUAL_SOURCE));
                result.put("roundId", roundId);
                result.put("generation", generation);
                result.put("status", data.getString(ScreenCaptureService.EXTRA_VISUAL_STATUS));
                result.put("width", capture.width);
                result.put("height", capture.height);
                result.put("bytes", capture.image.length);
                call.resolve(result);
            }
        };
        if (!ScreenCaptureService.captureSnapshot(receiver, false, roundId)) {
            call.reject("屏幕共享未启动");
        }
    }

    @PluginMethod
    public void markVisualSpeechStarted(PluginCall call) {
        String roundId = call.getString("roundId");
        if (roundId == null || roundId.isEmpty()) {
            call.reject("缺少 roundId");
            return;
        }
        ScreenCaptureService.markVisualSpeechStarted(roundId);
        call.resolve();
    }

    @PluginMethod
    public void markVisualSending(PluginCall call) {
        String roundId = call.getString("roundId");
        if (roundId == null || roundId.isEmpty()) {
            call.reject("缺少 roundId");
            return;
        }
        ScreenCaptureService.markVisualSending(roundId);
        call.resolve();
    }

    @PluginMethod
    public void setVisualImageCount(PluginCall call) {
        String roundId = call.getString("roundId");
        int imageCount = call.getInt("imageCount", -1);
        int maxImages = call.getInt("maxImages", -1);
        if (roundId == null || roundId.isEmpty() || imageCount < 0 || maxImages < 1 || imageCount > maxImages) {
            call.reject("截图数量无效");
            return;
        }
        ScreenCaptureService.setVisualImageCount(roundId, imageCount, maxImages);
        call.resolve();
    }

    @PluginMethod
    public void setCallStatus(PluginCall call) {
        ScreenCaptureService.setCallStatus(call.getString("status"));
        call.resolve();
    }

    @PluginMethod
    public void finishVisualRound(PluginCall call) {
        String roundId = call.getString("roundId");
        if (roundId == null || roundId.isEmpty()) {
            call.reject("缺少 roundId");
            return;
        }
        boolean success = call.getBoolean("success", false);
        ScreenCaptureService.finishVisualRound(roundId, success);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, ScreenCaptureService.class));
        call.resolve(activeResult(false));
    }

    private JSObject activeResult(boolean active) {
        JSObject result = new JSObject();
        result.put("active", active);
        return result;
    }
}
