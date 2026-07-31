package io.github.rithwikbabu.packwright.capture.mixin;

import io.github.rithwikbabu.packwright.capture.CaptureRuntime;
import net.minecraft.client.Camera;
import net.minecraft.client.DeltaTracker;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Camera.class)
abstract class CameraMixin {
    @Inject(method = "update", at = @At("TAIL"))
    private void packwrightCapture$applyPlannedRenderPose(
            DeltaTracker deltaTracker, CallbackInfo callback) {
        CaptureRuntime.applyPlannedCameraPose((Camera) (Object) this);
    }
}
