package com.xiaoxianggu.videocall;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioDeviceCallback;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private AudioManager audioManager;
    private AudioManager.AudioRecordingCallback recordingCallback;
    private AudioManager.OnCommunicationDeviceChangedListener communicationDeviceListener;
    private AudioDeviceCallback audioDeviceCallback;
    private AudioDiagnosticStore audioDiagnosticStore;
    private boolean callAudioActive;
    private int previousAudioMode;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepScreenOnPlugin.class);
        registerPlugin(ScreenCapturePlugin.class);
        registerPlugin(CallAudioPlugin.class);
        super.onCreate(savedInstanceState);
        startAudioRouteDiagnostics();
    }

    @Override
    protected void load() {
        // Capacitor starts loading the first page inside super.load().
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        if (webView != null && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            audioDiagnosticStore = new AudioDiagnosticStore(this);
            webView.addJavascriptInterface(audioDiagnosticStore, "LumeetAudioDiagnostic");
        }
        super.load();
    }

    @Override
    public void onStart() {
        super.onStart();
        ScreenCaptureService.setAppVisible(true);
    }

    @Override
    public void onStop() {
        ScreenCaptureService.setAppVisible(false);
        super.onStop();
    }

    @Override
    public void onDestroy() {
        if (callAudioActive) setCallAudioActive(false);
        if (audioManager != null && recordingCallback != null) {
            audioManager.unregisterAudioRecordingCallback(recordingCallback);
        }
        if (audioManager != null && audioDeviceCallback != null) {
            audioManager.unregisterAudioDeviceCallback(audioDeviceCallback);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && audioManager != null && communicationDeviceListener != null) {
            audioManager.removeOnCommunicationDeviceChangedListener(communicationDeviceListener);
        }
        super.onDestroy();
    }

    private void startAudioRouteDiagnostics() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        recordingCallback = new AudioManager.AudioRecordingCallback() {
            @Override
            public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                logRecordingRoutes(configs);
            }
        };
        audioManager.registerAudioRecordingCallback(recordingCallback, new Handler(Looper.getMainLooper()));
        logRecordingRoutes(audioManager.getActiveRecordingConfigurations());
        audioDeviceCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                selectBluetoothCommunicationDevice("device_added");
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                selectBluetoothCommunicationDevice("device_removed");
            }
        };
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, new Handler(Looper.getMainLooper()));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            communicationDeviceListener = device -> {
                logNativeLatency("native_audio_communication_route at_ms=" + System.currentTimeMillis()
                        + " output_type=" + audioDeviceType(device));
                logRecordingRoutes(audioManager.getActiveRecordingConfigurations());
                selectBluetoothCommunicationDevice("route_changed");
            };
            audioManager.addOnCommunicationDeviceChangedListener(getMainExecutor(), communicationDeviceListener);
        }
    }

    private void logRecordingRoutes(List<AudioRecordingConfiguration> configs) {
        StringBuilder routes = new StringBuilder();
        for (AudioRecordingConfiguration config : configs) {
            if (routes.length() > 0) routes.append(',');
            AudioFormat clientFormat = config.getClientFormat();
            AudioFormat inputFormat = config.getFormat();
            routes.append("input_type=").append(Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                            ? audioDeviceType(config.getAudioDevice()) : "unsupported")
                    .append(":source=").append(config.getClientAudioSource())
                    .append(":input_sample_rate=").append(inputFormat.getSampleRate())
                    .append(":input_channels=").append(inputFormat.getChannelCount())
                    .append(":client_sample_rate=").append(clientFormat.getSampleRate())
                    .append(":client_channels=").append(clientFormat.getChannelCount());
        }
        AudioDeviceInfo communicationDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? audioManager.getCommunicationDevice() : null;
        logNativeLatency("native_audio_input_routes at_ms=" + System.currentTimeMillis()
                + " scope=active_device_recordings"
                + " active=" + configs.size()
                + " routes=" + (routes.length() == 0 ? "none" : routes)
                + " communication_output=" + (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? audioDeviceType(communicationDevice) : "unsupported"));
    }

    private void logNativeLatency(String line) {
        Log.i("CallLatency", line);
        if (audioDiagnosticStore != null) audioDiagnosticStore.appendLatency("CallLatency " + line);
    }

    private String audioDeviceType(AudioDeviceInfo device) {
        if (device == null) return "none";
        switch (device.getType()) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "bluetooth_sco";
            case AudioDeviceInfo.TYPE_BLE_HEADSET: return "ble_headset";
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "builtin_mic";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "builtin_earpiece";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "builtin_speaker";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "wired_headset";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "wired_headphones";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "usb_headset";
            default: return "type_" + device.getType();
        }
    }

    public void setCallAudioActive(boolean active) {
        if (active == callAudioActive) return;
        if (active) {
            previousAudioMode = audioManager.getMode();
            callAudioActive = true;
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            selectBluetoothCommunicationDevice("call_started");
            return;
        }
        callAudioActive = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice();
        audioManager.setMode(previousAudioMode);
        logNativeLatency("native_call_audio_route at_ms=" + System.currentTimeMillis()
                + " active=false mode=" + audioManager.getMode());
    }

    private void selectBluetoothCommunicationDevice(String reason) {
        if (!callAudioActive || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        AudioDeviceInfo current = audioManager.getCommunicationDevice();
        if (isBluetoothCommunicationDevice(current)) return;
        for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
            if (!isBluetoothCommunicationDevice(device)) continue;
            boolean selected = audioManager.setCommunicationDevice(device);
            logNativeLatency("native_call_audio_route at_ms=" + System.currentTimeMillis()
                    + " active=true reason=" + reason + " requested=" + audioDeviceType(device)
                    + " selected=" + selected + " current=" + audioDeviceType(audioManager.getCommunicationDevice()));
            return;
        }
    }

    private boolean isBluetoothCommunicationDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || type == AudioDeviceInfo.TYPE_BLE_HEADSET
                || type == AudioDeviceInfo.TYPE_HEARING_AID;
    }

    private static final class AudioDiagnosticStore {
        private static final int MAX_BYTES = 48 * 1024 * 1024;
        private final Context context;
        private final File latencyDirectory;
        private String activeCall;
        private long expiresAt;
        private int bytesWritten;

        AudioDiagnosticStore(Context context) {
            this.context = context.getApplicationContext();
            latencyDirectory = this.context.getNoBackupFilesDir();
        }

        @JavascriptInterface
        public void appendLatency(String line) {
            CallLatencyStore.append(latencyDirectory, line);
        }

        @JavascriptInterface
        public synchronized boolean begin(String callId) {
            File marker = new File(context.getFilesDir(), "audio-diagnostic-next");
            if (callId == null || !callId.matches("[a-f0-9-]{36}") || !marker.delete()) return false;
            File dir = new File(context.getCacheDir(), "audio-diagnostic");
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File[] previous = dir.listFiles();
            if (previous == null) return false;
            for (File file : previous) {
                if (!file.delete()) return false;
            }
            activeCall = callId;
            expiresAt = SystemClock.elapsedRealtime() + 305_000;
            bytesWritten = 0;
            return true;
        }

        @JavascriptInterface
        public synchronized boolean savePcm(String callId, String name, String pcm) {
            if (callId == null || !callId.equals(activeCall) || name == null || pcm == null
                    || SystemClock.elapsedRealtime() > expiresAt
                    || !name.matches("(mic|(?:live|fallback)-[a-f0-9-]{36})-[0-9]{4,6}-[0-9]{13}-[0-9]{1,4}\\.pcm")
                    || pcm.length() > 600_000) return false;
            File file = new File(new File(context.getCacheDir(), "audio-diagnostic"), name);
            try {
                byte[] bytes = Base64.decode(pcm, Base64.NO_WRAP);
                if (bytes.length == 0 || bytes.length % 2 != 0
                        || bytesWritten + bytes.length > MAX_BYTES || !file.createNewFile()) return false;
                bytesWritten += bytes.length;
                try (FileOutputStream stream = new FileOutputStream(file)) {
                    stream.write(bytes);
                }
                return true;
            } catch (IOException | IllegalArgumentException error) {
                return false;
            }
        }
    }
}
