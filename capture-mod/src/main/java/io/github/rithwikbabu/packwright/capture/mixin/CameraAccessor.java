package io.github.rithwikbabu.packwright.capture.mixin;

import net.minecraft.client.Camera;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Narrow access to the camera pose setters used by the hash-bound studio plan. */
@Mixin(Camera.class)
public interface CameraAccessor {
    @Accessor("fov")
    void packwrightCapture$setFov(float fov);

    @Invoker("setPosition")
    void packwrightCapture$setPosition(double x, double y, double z);

    @Invoker("setRotation")
    void packwrightCapture$setRotation(float yaw, float pitch);
}
