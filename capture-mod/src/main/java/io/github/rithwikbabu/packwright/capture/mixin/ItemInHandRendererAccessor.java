package io.github.rithwikbabu.packwright.capture.mixin;

import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.renderer.ItemInHandRenderer;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Narrows deterministic scene setup to the four vanilla hand-equip state fields. */
@Mixin(ItemInHandRenderer.class)
public interface ItemInHandRendererAccessor {
    @Accessor("mainHandItem")
    ItemStack packwrightCapture$getMainHandItem();

    @Accessor("mainHandItem")
    void packwrightCapture$setMainHandItem(ItemStack stack);

    @Accessor("offHandItem")
    ItemStack packwrightCapture$getOffHandItem();

    @Accessor("offHandItem")
    void packwrightCapture$setOffHandItem(ItemStack stack);

    @Accessor("mainHandHeight")
    void packwrightCapture$setMainHandHeight(float height);

    @Accessor("oMainHandHeight")
    void packwrightCapture$setPreviousMainHandHeight(float height);

    @Accessor("offHandHeight")
    void packwrightCapture$setOffHandHeight(float height);

    @Accessor("oOffHandHeight")
    void packwrightCapture$setPreviousOffHandHeight(float height);

    @Invoker("renderPlayerArm")
    void packwrightCapture$renderPlayerArm(
            PoseStack poseStack,
            SubmitNodeCollector collector,
            int packedLight,
            float equipProgress,
            float swingProgress,
            HumanoidArm arm);
}
