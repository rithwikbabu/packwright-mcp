package io.github.rithwikbabu.packwright.capture;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import org.joml.Matrix3x2fStack;

/** Neutral evidence scene rendered by Minecraft's real GUI item-model pipeline. */
final class ItemInspectionScreen extends Screen {
    private static final int BACKGROUND = 0xff202428;
    private final ItemStack item;
    private final boolean showTooltip;
    private boolean itemSubmitted;
    private boolean tooltipSubmitted;

    ItemInspectionScreen(ItemStack item) {
        this(item, false);
    }

    ItemInspectionScreen(ItemStack item, boolean showTooltip) {
        super(Component.literal("Packwright item inspection"));
        this.item = item.copy();
        this.showTooltip = showTooltip;
    }

    @Override
    public void extractRenderState(
            GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
        graphics.fill(0, 0, width, height, BACKGROUND);
        float scale = showTooltip
                ? 2.0f
                : Math.max(1, Math.min(width, height) * 0.6f / 16.0f);
        float itemX = showTooltip ? width / 2.0f - 80.0f : width / 2.0f - 8.0f * scale;
        float itemY = height / 2.0f - 8.0f * scale;
        Matrix3x2fStack pose = graphics.pose();
        pose.pushMatrix();
        pose.translate(itemX, itemY);
        pose.scale(scale, scale);
        graphics.item(item, 0, 0, 0);
        pose.popMatrix();
        itemSubmitted = true;
        if (showTooltip) {
            graphics.setTooltipForNextFrame(font, item, width / 2 - 32, height / 2);
            tooltipSubmitted = true;
        }
    }

    boolean submittedExactItem(ItemStack expected, boolean requireTooltip) {
        return itemSubmitted
                && (!requireTooltip || tooltipSubmitted)
                && item.getCount() == expected.getCount()
                && ItemStack.isSameItemSameComponents(item, expected);
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }
}
