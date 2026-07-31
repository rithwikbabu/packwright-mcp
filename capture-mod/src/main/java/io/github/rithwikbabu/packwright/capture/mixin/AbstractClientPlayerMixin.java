package io.github.rithwikbabu.packwright.capture.mixin;

import io.github.rithwikbabu.packwright.capture.CaptureRuntime;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(AbstractClientPlayer.class)
abstract class AbstractClientPlayerMixin {
    private static final PlayerSkin PACKWRIGHT_WIDE_SKIN = captureSkin(
            "entity/player/wide/steve", PlayerModelType.WIDE);
    private static final PlayerSkin PACKWRIGHT_SLIM_SKIN = captureSkin(
            "entity/player/slim/alex", PlayerModelType.SLIM);

    @Inject(method = "getSkin", at = @At("RETURN"), cancellable = true)
    private void packwrightCapture$overridePlayerModel(CallbackInfoReturnable<PlayerSkin> callback) {
        PlayerModelType override = CaptureRuntime.playerModelOverride();
        if (override == null) return;
        callback.setReturnValue(override == PlayerModelType.WIDE
                ? PACKWRIGHT_WIDE_SKIN
                : PACKWRIGHT_SLIM_SKIN);
    }

    private static PlayerSkin captureSkin(String texture, PlayerModelType model) {
        return new PlayerSkin(
                new ClientAsset.ResourceTexture(Identifier.withDefaultNamespace(texture)),
                null,
                null,
                model,
                true);
    }
}
