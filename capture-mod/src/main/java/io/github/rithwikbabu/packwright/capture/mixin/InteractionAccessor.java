package io.github.rithwikbabu.packwright.capture.mixin;

import net.minecraft.world.entity.Interaction;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Interaction.class)
public interface InteractionAccessor {
    @Invoker("setWidth")
    void packwrightCapture$setWidth(float width);

    @Invoker("setHeight")
    void packwrightCapture$setHeight(float height);

    @Invoker("setResponse")
    void packwrightCapture$setResponse(boolean response);

    @Invoker("getWidth")
    float packwrightCapture$getWidth();

    @Invoker("getHeight")
    float packwrightCapture$getHeight();

    @Invoker("getResponse")
    boolean packwrightCapture$getResponse();
}
