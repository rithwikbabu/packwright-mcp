package io.github.rithwikbabu.packwright.capture.mixin;

import io.github.rithwikbabu.packwright.capture.CaptureRuntime;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
abstract class GameRendererMixin {
    @Inject(method = "render", at = @At("HEAD"))
    private void packwrightCapture$beforeRender(
            DeltaTracker deltaTracker, boolean renderLevel, CallbackInfo callback) {
        CaptureRuntime.onRenderFrameStarted();
    }

    @Inject(method = "render", at = @At("TAIL"))
    private void packwrightCapture$afterRender(
            DeltaTracker deltaTracker, boolean renderLevel, CallbackInfo callback) {
        CaptureRuntime.onRenderedFrame(Minecraft.getInstance(), renderLevel);
    }
}
