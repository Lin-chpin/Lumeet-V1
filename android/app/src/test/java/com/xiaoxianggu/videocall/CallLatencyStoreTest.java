package com.xiaoxianggu.videocall;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class CallLatencyStoreTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private String read(File file) throws Exception {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    @Test public void writesOnlyBoundedDiagnosticLines() throws Exception {
        File directory = folder.getRoot();
        CallLatencyStore.append(directory, "普通页面日志");
        CallLatencyStore.append(directory, "CallLatency event\nforged_line");
        CallLatencyStore.append(directory, "CallLatency event\rforged_line");
        CallLatencyStore.append(directory, "CallLatency " + "界".repeat(2000));
        CallLatencyStore.append(directory, "CallLatency valid");

        assertEquals("CallLatency valid\n", read(new File(directory, "call-latency.log")));
    }

    @Test public void retainsOnlyCurrentFileAndMostRecentRotation() throws Exception {
        File directory = folder.getRoot();
        for (String prefix : new String[] {"CallLatency oldest ", "CallLatency previous "}) {
            String line = prefix + "x".repeat(4095 - prefix.length());
            for (int i = 0; i < CallLatencyStore.MAX_FILE_BYTES / 4096; i++) {
                CallLatencyStore.append(directory, line);
            }
        }
        CallLatencyStore.append(directory, "CallLatency latest");

        File previous = new File(directory, "call-latency.log.previous");
        assertEquals(CallLatencyStore.MAX_FILE_BYTES, previous.length());
        assertTrue(read(previous).startsWith("CallLatency previous "));
        assertEquals("CallLatency latest\n", read(new File(directory, "call-latency.log")));
    }
}
