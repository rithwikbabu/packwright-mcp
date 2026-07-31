package io.github.rithwikbabu.packwright.capture.mixin;

import net.minecraft.world.entity.Display;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(Display.ItemDisplay.class)
public interface ItemDisplayAccessor {
    @Invoker("setItemStack")
    void packwrightCapture$setItemStack(ItemStack stack);

    @Invoker("setItemTransform")
    void packwrightCapture$setItemTransform(ItemDisplayContext context);

    @Invoker("getItemStack")
    ItemStack packwrightCapture$getItemStack();

    @Invoker("getItemTransform")
    ItemDisplayContext packwrightCapture$getItemTransform();
}
