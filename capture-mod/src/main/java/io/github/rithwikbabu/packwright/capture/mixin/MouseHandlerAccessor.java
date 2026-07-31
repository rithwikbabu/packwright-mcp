package io.github.rithwikbabu.packwright.capture.mixin;

import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Restricts deterministic cursor placement to Minecraft's cached coordinates. */
@Mixin(MouseHandler.class)
public interface MouseHandlerAccessor {
    @Accessor("xpos")
    void packwrightCapture$setX(double value);

    @Accessor("ypos")
    void packwrightCapture$setY(double value);
}
