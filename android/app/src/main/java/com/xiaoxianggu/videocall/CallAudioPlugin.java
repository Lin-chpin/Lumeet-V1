package com.xiaoxianggu.videocall;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CallAudio")
public class CallAudioPlugin extends Plugin {
    @PluginMethod
    public void setActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active"));
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).setCallAudioActive(active);
        }
        call.resolve();
    }
}
