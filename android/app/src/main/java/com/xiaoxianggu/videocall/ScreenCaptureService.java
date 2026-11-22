package com.xiaoxianggu.videocall;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.ResultReceiver;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.UUID;

public class ScreenCaptureService extends Service {
    public static final String ACTION_START = "com.xiaoxianggu.videocall.SCREEN_CAPTURE_START";
    public static final String ACTION_VISUAL_CAPTURE_STARTED = "com.xiaoxianggu.videocall.VISUAL_CAPTURE_STARTED";
    public static final String ACTION_VISUAL_CAPTURE_RESULT = "com.xiaoxianggu.videocall.VISUAL_CAPTURE_RESULT";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_START_RESULT = "startResult";
    public static final String EXTRA_VISUAL_SOURCE = "visualSource";
    public static final String EXTRA_VISUAL_ROUND_ID = "visualRoundId";
    public static final String EXTRA_VISUAL_STATUS = "visualStatus";
    public static final String EXTRA_VISUAL_GENERATION = "visualGeneration";

    public static final int START_RESULT_FAILED = 0;
    public static final int START_RESULT_ACTIVE = 1;
    public static final int VISUAL_RESULT_FAILED = 2;
    public static final int VISUAL_RESULT_READY = 3;

    private static final String CHANNEL_ID = "screen_capture";
    private static final int NOTIFICATION_ID = 4207;
    private static final long SNAPSHOT_TIMEOUT_MS = 1_500;
    private static final int SNAPSHOT_SETTLE_FRAME_COUNT = 2;
    private static final int MAX_SNAPSHOT_LONG_EDGE = 2_560;
    private static final int MAX_SNAPSHOT_JPEG_BYTES = 3_000_000;
    private static volatile ScreenCaptureService current;
    private static volatile boolean appVisible = true;
    private final Object visualRoundLock = new Object();
    private volatile String callStatus = "";

    private HandlerThread captureThread;
    private Handler captureHandler;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ScreenShareFloatingBall floatingBall;
    private MediaProjection projection;
    private VirtualDisplay display;
    private volatile ImageReader reader;
    private MediaProjection.Callback projectionCallback;
    private volatile byte[] latestFrame;
    private volatile byte[] pendingVisualFrame;
    private volatile String pendingVisualRoundId;
    private volatile String pendingVisualStatus;
    private volatile int pendingVisualWidth;
    private volatile int pendingVisualHeight;
    private volatile boolean active;
    private long lastFrameAt;
    private long frameSequence;
    private long snapshotGeneration;
    private volatile long snapshotInProgressGeneration;
    private SnapshotRequest snapshotRequest;
    private int densityDpi;

    public static boolean isActive() {
        ScreenCaptureService service = current;
        return service != null && service.active;
    }

    public static byte[] latestFrame() {
        ScreenCaptureService service = current;
        byte[] frame = service == null ? null : service.latestFrame;
        return frame == null ? null : frame.clone();
    }

    public static void setAppVisible(boolean visible) {
        appVisible = visible;
        ScreenCaptureService service = current;
        if (service != null) service.refreshFloatingBall();
    }

    public static void setCallStatus(String status) {
        ScreenCaptureService service = current;
        if (service == null) return;
        String value = status == null ? "" : status.trim();
        service.callStatus = value;
        service.mainHandler.post(() -> {
            if (service.floatingBall != null) service.floatingBall.setCallStatus(value);
        });
    }

    public static boolean captureSnapshot(ResultReceiver resultReceiver, boolean notifyPlugin, String roundId) {
        ScreenCaptureService service = current;
        if (service == null || !service.active) return false;
        service.beginSnapshot(resultReceiver, notifyPlugin, roundId);
        return true;
    }

    public static void markVisualSpeechStarted(String roundId) {
        ScreenCaptureService service = current;
        if (service == null || roundId == null || service.captureHandler == null) return;
        service.captureHandler.post(() -> {
            boolean currentRound;
            synchronized (service.visualRoundLock) {
                currentRound = roundId.equals(service.pendingVisualRoundId);
                if (currentRound) service.pendingVisualStatus = "正在听你说";
            }
            if (currentRound) service.setVisualStatus(roundId, "正在听你说");
        });
    }

    public static void markVisualSending(String roundId) {
        ScreenCaptureService service = current;
        if (service == null || roundId == null || service.captureHandler == null) return;
        service.captureHandler.post(() -> {
            boolean currentRound;
            synchronized (service.visualRoundLock) {
                currentRound = roundId.equals(service.pendingVisualRoundId);
                if (currentRound) service.pendingVisualStatus = "发送中";
            }
            if (currentRound) service.setVisualStatus(roundId, "发送中");
        });
    }

    public static void setVisualImageCount(String roundId, int imageCount, int maxImages) {
        ScreenCaptureService service = current;
        if (service == null || roundId == null || service.captureHandler == null) return;
        service.captureHandler.post(() -> {
            boolean currentRound;
            synchronized (service.visualRoundLock) {
                currentRound = roundId.equals(service.pendingVisualRoundId);
            }
            if (!currentRound) return;
            service.mainHandler.post(() -> {
                synchronized (service.visualRoundLock) {
                    if (!roundId.equals(service.pendingVisualRoundId)) return;
                }
                if (service.floatingBall != null) service.floatingBall.setVisualImageCount(imageCount, maxImages);
            });
        });
    }

    public static void finishVisualRound(String roundId, boolean success) {
        ScreenCaptureService service = current;
        if (service == null || roundId == null || service.captureHandler == null) return;
        service.captureHandler.post(() -> {
            String status;
            synchronized (service.visualRoundLock) {
                if (!roundId.equals(service.pendingVisualRoundId)) return;
                if (success) {
                    service.pendingVisualFrame = null;
                    service.pendingVisualWidth = 0;
                    service.pendingVisualHeight = 0;
                    service.pendingVisualStatus = "画面已发送";
                } else {
                    service.pendingVisualStatus = "发送失败，画面已保留";
                }
                status = service.pendingVisualStatus;
            }
            service.setVisualStatus(roundId, status);
        });
    }

    private static final class SnapshotRequest {
        final String roundId;
        final ResultReceiver receiver;
        final boolean notifyPlugin;
        long generation;
        long afterSequence;
        long afterWindowHiddenTimestampNanos;
        int settleFramesRemaining;
        Runnable timeout;

        SnapshotRequest(String roundId, ResultReceiver receiver, boolean notifyPlugin) {
            this.roundId = roundId;
            this.receiver = receiver;
            this.notifyPlugin = notifyPlugin;
        }
    }

    public static final class VisualCapture {
        public final byte[] image;
        public final int width;
        public final int height;

        private VisualCapture(byte[] image, int width, int height) {
            this.image = image;
            this.width = width;
            this.height = height;
        }
    }

    private static final class EncodedFrame {
        final byte[] bytes;
        final int width;
        final int height;

        EncodedFrame(byte[] bytes, int width, int height) {
            this.bytes = bytes;
            this.width = width;
            this.height = height;
        }
    }

    public static VisualCapture readVisualCapture(String roundId, long generation) {
        ScreenCaptureService service = current;
        if (service == null || roundId == null) return null;
        synchronized (service.visualRoundLock) {
            byte[] frame = service.pendingVisualFrame;
            if (generation != service.snapshotGeneration
                || !roundId.equals(service.pendingVisualRoundId) || frame == null
                || service.pendingVisualWidth <= 0 || service.pendingVisualHeight <= 0) return null;
            return new VisualCapture(frame.clone(), service.pendingVisualWidth, service.pendingVisualHeight);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        current = this;
        floatingBall = new ScreenShareFloatingBall(
            this,
            this::openMainActivity,
            () -> beginSnapshot(null, true, null)
        );
        floatingBall.setCallStatus(callStatus);
        captureThread = new HandlerThread("LumeetScreenCapture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ResultReceiver resultReceiver = null;
        try {
            // A service launched with startForegroundService must enter the foreground
            // before validating input or doing any projection setup.
            startCaptureForeground();
            resultReceiver = intent == null ? null : getResultReceiver(intent);
            if (intent == null || !ACTION_START.equals(intent.getAction())) {
                throw new IllegalArgumentException("屏幕共享启动请求无效");
            }
            if (active) {
                notifyStartResult(resultReceiver, START_RESULT_ACTIVE, null);
                return START_NOT_STICKY;
            }
            if (!intent.hasExtra(EXTRA_RESULT_CODE)) {
                throw new IllegalArgumentException("缺少屏幕共享授权结果");
            }
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent data = getIntentExtra(intent);
            if (resultCode != Activity.RESULT_OK || data == null) {
                throw new IllegalArgumentException("屏幕共享授权无效");
            }

            MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
            if (manager == null) throw new IllegalStateException("MediaProjection unavailable");
            projection = manager.getMediaProjection(resultCode, data);
            if (projection == null) throw new IllegalStateException("MediaProjection unavailable");
            projectionCallback = new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopCapture(false);
                }

                @Override
                public void onCapturedContentResize(int width, int height) {
                    if (active) resize(width, height);
                }
            };
            projection.registerCallback(projectionCallback, captureHandler);
            DisplayMetrics metrics = getResources().getDisplayMetrics();
            densityDpi = metrics.densityDpi;
            int width = metrics.widthPixels;
            int height = metrics.heightPixels;
            if (width <= 0 || height <= 0) throw new IllegalStateException("Invalid display size");
            resize(width, height);
            active = true;
            refreshFloatingBall();
            notifyStartResult(resultReceiver, START_RESULT_ACTIVE, null);
        } catch (Exception e) {
            if (resultReceiver == null && intent != null) {
                try { resultReceiver = getResultReceiver(intent); }
                catch (Exception ignored) {}
            }
            notifyStartResult(resultReceiver, START_RESULT_FAILED, e.getMessage());
            stopCapture(true);
        }
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private ResultReceiver getResultReceiver(Intent intent) {
        return intent.getParcelableExtra(EXTRA_START_RESULT);
    }

    private void notifyStartResult(ResultReceiver receiver, int resultCode, String message) {
        if (receiver == null) return;
        Bundle result = new Bundle();
        if (message != null) result.putString("message", message);
        receiver.send(resultCode, result);
    }

    @SuppressWarnings("deprecation")
    private Intent getIntentExtra(Intent intent) {
        return intent.getParcelableExtra(EXTRA_RESULT_DATA);
    }

    private void startCaptureForeground() {
        Intent openApp = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openApp, flags);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("正在共享屏幕")
            .setContentText("只有点发送画面时，截图才会发给 AI")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int serviceType = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            startForeground(NOTIFICATION_ID, notification, serviceType);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "屏幕共享",
            NotificationManager.IMPORTANCE_LOW
        );
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void refreshFloatingBall() {
        Runnable update = () -> {
            if (floatingBall == null) return;
            if (active && !appVisible && snapshotInProgressGeneration == 0) floatingBall.show();
            else floatingBall.hide();
        };
        if (Looper.myLooper() == Looper.getMainLooper()) update.run();
        else mainHandler.post(update);
    }

    private void openMainActivity() {
        Intent openApp = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(openApp);
    }

    private void beginSnapshot(ResultReceiver receiver, boolean notifyPlugin, String requestedRoundId) {
        if (!active || captureHandler == null) {
            Log.i("CallLatency", "native_snapshot_rejected reason=projection_inactive");
            finishSnapshot(null, receiver, notifyPlugin, null, "屏幕共享未启动");
            return;
        }
        String roundId = requestedRoundId == null || requestedRoundId.isEmpty()
            ? UUID.randomUUID().toString()
            : requestedRoundId;
        SnapshotRequest request = new SnapshotRequest(roundId, receiver, notifyPlugin);
        Runnable prepare = () -> {
            synchronized (visualRoundLock) {
                request.generation = ++snapshotGeneration;
                snapshotInProgressGeneration = request.generation;
                pendingVisualFrame = null;
                pendingVisualRoundId = roundId;
                pendingVisualStatus = "正在截图";
                pendingVisualWidth = 0;
                pendingVisualHeight = 0;
            }
            Log.i("CallLatency", "native_snapshot_started round=" + diagnosticRoundId(roundId)
                + " generation=" + request.generation + " floating_button=" + notifyPlugin);
            if (notifyPlugin) {
                Bundle started = new Bundle();
                started.putString(EXTRA_VISUAL_ROUND_ID, roundId);
                started.putString(EXTRA_VISUAL_SOURCE, "screen");
                started.putString(EXTRA_VISUAL_STATUS, "capturing");
                started.putLong(EXTRA_VISUAL_GENERATION, request.generation);
                Intent event = new Intent(ACTION_VISUAL_CAPTURE_STARTED)
                    .setPackage(getPackageName())
                    .putExtras(started);
                sendBroadcast(event);
            }
            if (floatingBall != null) {
                if (!floatingBall.hide()) {
                    finishSnapshot(request, receiver, notifyPlugin, null, "悬浮窗隐藏失败");
                    return;
                }
                floatingBall.clearVisualFeedback();
                floatingBall.setVisualStatus("正在截图");
            }
            long windowHiddenTimestampNanos = System.nanoTime();
            captureHandler.post(() -> {
                SnapshotRequest previous = snapshotRequest;
                if (previous != null) {
                    if (previous.timeout != null) captureHandler.removeCallbacks(previous.timeout);
                    finishSnapshot(previous, previous.receiver, previous.notifyPlugin, null, "已被新的截图替换");
                }
                synchronized (visualRoundLock) {
                    pendingVisualFrame = null;
                    pendingVisualRoundId = roundId;
                    pendingVisualStatus = "正在截图";
                    pendingVisualWidth = 0;
                    pendingVisualHeight = 0;
                }
                snapshotRequest = request;
                discardPendingFrame();
                if (snapshotRequest != request) return;
                request.afterSequence = frameSequence;
                request.afterWindowHiddenTimestampNanos = windowHiddenTimestampNanos;
                request.settleFramesRemaining = SNAPSHOT_SETTLE_FRAME_COUNT;
                request.timeout = () -> {
                    if (snapshotRequest != request) return;
                    snapshotRequest = null;
                    finishSnapshot(request, receiver, notifyPlugin, null, "新屏幕帧未及时到达");
                };
                captureHandler.postDelayed(request.timeout, SNAPSHOT_TIMEOUT_MS);
            });
        };
        if (Looper.myLooper() == Looper.getMainLooper()) prepare.run();
        else mainHandler.post(prepare);
    }

    private void discardPendingFrame() {
        Image stale = null;
        try {
            if (reader != null) stale = reader.acquireLatestImage();
        } catch (IllegalStateException ignored) {
            // A queued reader callback may have consumed the pending frame already.
        } finally {
            if (stale != null) stale.close();
        }
    }

    private void finishSnapshot(
        SnapshotRequest request,
        ResultReceiver receiver,
        boolean notifyPlugin,
        EncodedFrame image,
        String error
    ) {
        String roundId = request == null ? UUID.randomUUID().toString() : request.roundId;
        boolean currentRequest;
        boolean ready;
        boolean currentRound;
        String currentStatus = null;
        synchronized (visualRoundLock) {
            currentRequest = request == null || request.generation == snapshotInProgressGeneration;
            currentRound = currentRequest && roundId.equals(pendingVisualRoundId);
            ready = image != null && request != null && currentRound;
            if (ready) {
                pendingVisualFrame = image.bytes;
                pendingVisualWidth = image.width;
                pendingVisualHeight = image.height;
                if (!"正在听你说".equals(pendingVisualStatus)) pendingVisualStatus = "已截图，等待说话";
                currentStatus = pendingVisualStatus;
            } else if (currentRound) {
                String failure = error == null || error.isEmpty() ? "截图失败" : error;
                pendingVisualStatus = pendingVisualFrame == null ? failure : failure + "，画面已保留";
                currentStatus = pendingVisualStatus;
            }
            if (request != null && currentRequest
                && snapshotInProgressGeneration == request.generation) {
                snapshotInProgressGeneration = 0;
            }
        }
        if (image != null && !ready) error = "截图回合已被新的画面替换";
        if (request != null) {
            String result = ready ? "ready" : switch (error == null ? "" : error) {
                case "悬浮窗隐藏失败" -> "overlay_hide_failed";
                case "已被新的截图替换", "截图回合已被新的画面替换" -> "superseded";
                case "新屏幕帧未及时到达" -> "frame_timeout";
                case "屏幕截图编码失败" -> "encode_failed";
                case "屏幕共享已停止" -> "projection_stopped";
                default -> "failed";
            };
            Log.i("CallLatency", "native_snapshot_finished round=" + diagnosticRoundId(roundId)
                + " generation=" + request.generation + " result=" + result + " current=" + currentRound
                + (ready ? " width=" + image.width + " height=" + image.height + " bytes=" + image.bytes.length : ""));
        }
        int resultCode = ready ? VISUAL_RESULT_READY : VISUAL_RESULT_FAILED;
        Bundle result = new Bundle();
        result.putString(EXTRA_VISUAL_ROUND_ID, roundId);
        result.putString(EXTRA_VISUAL_SOURCE, "screen");
        result.putLong(EXTRA_VISUAL_GENERATION, request == null ? 0 : request.generation);
        if (ready) {
            setVisualFeedback(roundId, currentStatus, image.bytes);
        } else {
            if (currentStatus != null) {
                if (request == null) setVisualStatus(roundId, currentStatus);
                else setSnapshotVisualStatus(roundId, currentStatus, request.generation);
            }
        }
        result.putString(EXTRA_VISUAL_STATUS, ready ? "ready" : "failed");
        if (receiver != null) receiver.send(resultCode, result);
        if (notifyPlugin && request != null && currentRound) {
            Intent event = new Intent(ACTION_VISUAL_CAPTURE_RESULT)
                .setPackage(getPackageName())
                .putExtras(result);
            sendBroadcast(event);
        }
        refreshFloatingBall();
    }

    private static String diagnosticRoundId(String id) {
        return id.matches("[A-Za-z0-9_-]{1,80}") ? id : "unknown";
    }

    private void setVisualStatus(String roundId, String status) {
        Runnable update = () -> {
            synchronized (visualRoundLock) {
                if (!roundId.equals(pendingVisualRoundId)) return;
            }
            if (floatingBall != null) floatingBall.setVisualStatus(status);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) update.run();
        else mainHandler.post(update);
    }

    private void setSnapshotVisualStatus(String roundId, String status, long generation) {
        Runnable update = () -> {
            synchronized (visualRoundLock) {
                if (generation != snapshotGeneration || !roundId.equals(pendingVisualRoundId)) return;
            }
            if (floatingBall != null) floatingBall.setVisualStatus(status);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) update.run();
        else mainHandler.post(update);
    }

    private void setVisualFeedback(String roundId, String status, byte[] image) {
        Runnable update = () -> {
            synchronized (visualRoundLock) {
                if (!roundId.equals(pendingVisualRoundId) || pendingVisualFrame != image) return;
            }
            if (floatingBall != null) floatingBall.setVisualFeedback(status, image);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) update.run();
        else mainHandler.post(update);
    }

    private void resize(int width, int height) {
        if (width <= 0 || height <= 0 || projection == null) return;
        ImageReader nextReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        nextReader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);
        if (display == null) {
            display = projection.createVirtualDisplay(
                "LumeetScreenShare",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                nextReader.getSurface(),
                null,
                captureHandler
            );
        } else {
            display.resize(width, height, densityDpi);
            display.setSurface(nextReader.getSurface());
        }
        ImageReader oldReader = reader;
        reader = nextReader;
        if (oldReader != null) oldReader.close();
    }

    private void onImageAvailable(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null) return;
            if (source != reader) return;
            long now = SystemClock.elapsedRealtime();
            long sequence = ++frameSequence;
            SnapshotRequest request = snapshotRequest;
            boolean snapshotAfterWindowHidden = request != null
                && sequence > request.afterSequence
                && image.getTimestamp() > request.afterWindowHiddenTimestampNanos;
            boolean snapshotReady = snapshotAfterWindowHidden && request.settleFramesRemaining == 0;
            if (snapshotAfterWindowHidden && !snapshotReady) request.settleFramesRemaining--;

            if (now - lastFrameAt >= 500) {
                try {
                    byte[] preview = encodeFrame(image);
                    if (preview != null) {
                        latestFrame = preview;
                        lastFrameAt = now;
                    }
                } catch (Exception ignored) {
                    // A later preview frame can recover from transient bitmap errors.
                }
            }

            if (snapshotReady && snapshotRequest == request) {
                snapshotRequest = null;
                if (request.timeout != null) captureHandler.removeCallbacks(request.timeout);
                EncodedFrame snapshot = null;
                try { snapshot = encodeSnapshotFrame(image); }
                catch (Exception ignored) {}
                finishSnapshot(
                    request,
                    request.receiver,
                    request.notifyPlugin,
                    snapshot,
                    snapshot == null ? "屏幕截图编码失败" : null
                );
            }
        } catch (Exception ignored) {
            // Keep the active share alive; a later frame can recover from transient buffer errors.
        } finally {
            if (image != null) image.close();
        }
    }

    private byte[] encodeFrame(Image image) {
        Bitmap source = copyImageToBitmap(image);
        Bitmap scaled = scaleToLongEdge(source, 960);
        if (scaled != source) source.recycle();
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!scaled.compress(Bitmap.CompressFormat.JPEG, 65, output)) return null;
            return output.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            scaled.recycle();
        }
    }

    private EncodedFrame encodeSnapshotFrame(Image image) {
        Bitmap source = copyImageToBitmap(image);
        Bitmap current = scaleToLongEdge(source, MAX_SNAPSHOT_LONG_EDGE);
        if (current != source) source.recycle();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            int[] qualities = { 90, 85, 80, 75, 70, 65 };
            while (true) {
                for (int quality : qualities) {
                    output.reset();
                    if (current.compress(Bitmap.CompressFormat.JPEG, quality, output)
                        && output.size() <= MAX_SNAPSHOT_JPEG_BYTES) {
                        return new EncodedFrame(output.toByteArray(), current.getWidth(), current.getHeight());
                    }
                }
                int longEdge = Math.max(current.getWidth(), current.getHeight());
                if (longEdge <= 1) return null;
                int width = Math.max(1, (int) Math.round(current.getWidth() * 0.8));
                int height = Math.max(1, (int) Math.round(current.getHeight() * 0.8));
                Bitmap smaller = Bitmap.createScaledBitmap(current, width, height, true);
                if (smaller == current) return null;
                current.recycle();
                current = smaller;
            }
        } finally {
            current.recycle();
        }
    }

    private Bitmap copyImageToBitmap(Image image) {
        Image.Plane[] planes = image.getPlanes();
        if (planes.length == 0) throw new IllegalArgumentException("屏幕帧没有图像平面");
        Image.Plane plane = planes[0];
        ByteBuffer buffer = plane.getBuffer().duplicate();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int width = image.getWidth();
        int height = image.getHeight();
        int paddedWidth = width + Math.max(0, rowStride - pixelStride * width) / pixelStride;
        Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
        try {
            buffer.rewind();
            padded.copyPixelsFromBuffer(buffer);
            if (paddedWidth == width) return padded;
            Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
            padded.recycle();
            return cropped;
        } catch (RuntimeException e) {
            padded.recycle();
            throw e;
        }
    }

    private Bitmap scaleToLongEdge(Bitmap source, int maxLongEdge) {
        int width = source.getWidth();
        int height = source.getHeight();
        double scale = Math.min(1.0, (double) maxLongEdge / Math.max(width, height));
        int scaledWidth = Math.max(1, (int) Math.round(width * scale));
        int scaledHeight = Math.max(1, (int) Math.round(height * scale));
        if (scaledWidth == width && scaledHeight == height) return source;
        return Bitmap.createScaledBitmap(source, scaledWidth, scaledHeight, true);
    }

    private void stopCapture(boolean stopProjection) {
        active = false;
        latestFrame = null;
        SnapshotRequest request = snapshotRequest;
        snapshotRequest = null;
        if (request != null) {
            if (request.timeout != null && captureHandler != null) captureHandler.removeCallbacks(request.timeout);
            finishSnapshot(request, request.receiver, request.notifyPlugin, null, "屏幕共享已停止");
        }
        synchronized (visualRoundLock) {
            pendingVisualFrame = null;
            pendingVisualRoundId = null;
            pendingVisualStatus = null;
            pendingVisualWidth = 0;
            pendingVisualHeight = 0;
        }
        if (floatingBall != null) floatingBall.clearVisualFeedback();
        refreshFloatingBall();
        if (display != null) {
            try { display.release(); }
            catch (Exception ignored) {}
            display = null;
        }
        if (reader != null) {
            try { reader.close(); }
            catch (Exception ignored) {}
            reader = null;
        }
        MediaProjection currentProjection = projection;
        projection = null;
        if (currentProjection != null) {
            if (projectionCallback != null) {
                try { currentProjection.unregisterCallback(projectionCallback); }
                catch (Exception ignored) {}
            }
            if (stopProjection) {
                try { currentProjection.stop(); }
                catch (Exception ignored) {}
            }
        }
        projectionCallback = null;
        try { stopForeground(true); }
        catch (Exception ignored) {}
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopCapture(true);
        if (floatingBall != null) {
            floatingBall.close();
            floatingBall = null;
        }
        if (current == this) current = null;
        if (captureThread != null) captureThread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
