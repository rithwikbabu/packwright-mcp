package io.github.rithwikbabu.packwright.capture;

import net.fabricmc.api.ClientModInitializer;

public final class PackwrightCaptureClient implements ClientModInitializer {
    public static final String MOD_ID = "packwright_capture";
    public static final String MOD_VERSION = "0.5.0";

    @Override
    public void onInitializeClient() {
        CaptureRuntime.initialize();
    }
}
