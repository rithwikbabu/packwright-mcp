package io.github.rithwikbabu.packwright.capture.mixin;

import com.mojang.math.Transformation;
import net.minecraft.util.Brightness;
import net.minecraft.world.entity.Display;
import net.minecraft.network.syncher.SynchedEntityData;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Invokes only the typed display properties admitted by protocol v3. */
@Mixin(Display.class)
public interface DisplayAccessor {
    @Invoker("createTransformation")
    static Transformation packwrightCapture$createTransformation(SynchedEntityData data) {
        throw new AssertionError("Mixin invoker was not transformed");
    }

    @Invoker("setTransformation")
    void packwrightCapture$setTransformation(Transformation transformation);

    @Invoker("setTransformationInterpolationDuration")
    void packwrightCapture$setTransformationInterpolationDuration(int duration);

    @Invoker("setTransformationInterpolationDelay")
    void packwrightCapture$setTransformationInterpolationDelay(int delay);

    @Invoker("setBillboardConstraints")
    void packwrightCapture$setBillboardConstraints(Display.BillboardConstraints constraints);

    @Invoker("setBrightnessOverride")
    void packwrightCapture$setBrightnessOverride(Brightness brightness);

    @Invoker("setShadowRadius")
    void packwrightCapture$setShadowRadius(float radius);

    @Invoker("setShadowStrength")
    void packwrightCapture$setShadowStrength(float strength);

    @Invoker("getTransformationInterpolationDuration")
    int packwrightCapture$getTransformationInterpolationDuration();

    @Invoker("getTransformationInterpolationDelay")
    int packwrightCapture$getTransformationInterpolationDelay();

    @Invoker("getBillboardConstraints")
    Display.BillboardConstraints packwrightCapture$getBillboardConstraints();

    @Invoker("getBrightnessOverride")
    Brightness packwrightCapture$getBrightnessOverride();

    @Invoker("getShadowRadius")
    float packwrightCapture$getShadowRadius();

    @Invoker("getShadowStrength")
    float packwrightCapture$getShadowStrength();
}
