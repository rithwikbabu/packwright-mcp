package io.github.rithwikbabu.packwright.capture.mixin;

import io.github.rithwikbabu.packwright.capture.CaptureRuntime;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
abstract class MinecraftMixin {
    @Inject(method = "tick", at = @At("TAIL"))
    private void packwrightCapture$afterTick(CallbackInfo callback) {
        CaptureRuntime.onClientTick((Minecraft) (Object) this);
    }
}
