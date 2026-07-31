package io.github.rithwikbabu.packwright.capture.mixin;

import com.mojang.blaze3d.vertex.PoseStack;
import io.github.rithwikbabu.packwright.capture.CaptureRuntime;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.ItemInHandRenderer;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Adds an explicitly signed reference arm using Minecraft's own first-person arm renderer. */
@Mixin(ItemInHandRenderer.class)
abstract class ItemInHandRendererMixin {
    @Inject(method = "submitHandsWithItems", at = @At("HEAD"))
    private void packwrightCapture$submitReferenceArm(
            float partialTick,
            PoseStack poseStack,
            SubmitNodeCollector collector,
            LocalPlayer player,
            int packedLight,
            CallbackInfo callback) {
        ItemInHandRendererAccessor accessor = (ItemInHandRendererAccessor) (Object) this;
        ItemStack submittedMain = accessor.packwrightCapture$getMainHandItem();
        ItemStack submittedOff = accessor.packwrightCapture$getOffHandItem();
        CaptureRuntime.onVanillaHandSubmission(player, submittedMain, submittedOff);

        HumanoidArm referenceArm = CaptureRuntime.referenceArm();
        if (referenceArm == null) return;
        float swingProgress = player.getAttackAnim(partialTick);
        poseStack.pushPose();
        // Vanilla 26.2 does not draw an arm for ordinary non-empty items. Keep
        // this signed reference arm slightly behind the stock held-item plane
        // so it cannot hide the asset it is meant to contextualize.
        poseStack.translate(0.0F, 0.0F, -0.25F);
        accessor.packwrightCapture$renderPlayerArm(
                poseStack, collector, packedLight, 0.0F, swingProgress, referenceArm);
        poseStack.popPose();
        CaptureRuntime.onReferenceArmSubmission(referenceArm);
    }

    @Inject(method = "renderItem", at = @At("HEAD"))
    private void packwrightCapture$observeHeldItemRender(
            LivingEntity entity,
            ItemStack stack,
            ItemDisplayContext displayContext,
            PoseStack poseStack,
            SubmitNodeCollector collector,
            int packedLight,
            CallbackInfo callback) {
        CaptureRuntime.onVanillaItemRender(stack, displayContext);
    }
}
