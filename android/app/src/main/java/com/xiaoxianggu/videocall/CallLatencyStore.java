package com.xiaoxianggu.videocall;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class CallLatencyStore {
    static final int MAX_FILE_BYTES = 1024 * 1024;
    private static final int MAX_LINE_BYTES = 4096;

    private CallLatencyStore() {}

    static synchronized void append(File directory, String line) {
        if (directory == null || line == null || line.length() >= MAX_LINE_BYTES
                || !line.startsWith("CallLatency ") || line.indexOf('\n') >= 0
                || line.indexOf('\r') >= 0 || line.indexOf('\0') >= 0) return;

        byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_LINE_BYTES) return;
        File current = new File(directory, "call-latency.log");
        if (current.length() + bytes.length > MAX_FILE_BYTES) {
            File previous = new File(directory, "call-latency.log.previous");
            if ((previous.exists() && !previous.delete()) || !current.renameTo(previous)) return;
        }
        try (FileOutputStream output = new FileOutputStream(current, true)) {
            output.write(bytes);
        } catch (IOException ignored) {
            // A diagnostics write must not interrupt a call.
        }
    }
}
