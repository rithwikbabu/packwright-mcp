package io.github.rithwikbabu.packwright.capture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

final class PlaceableStudioGeometryTest {
    @Test
    void plainSceneRequiresThePreviousOcclusionContextToBeCleared() {
        BlockPos floorOrigin = PlaceableStudioGeometry.canonicalOrigin("floor");
        BlockPos occluder = floorOrigin.north(2);

        Set<BlockPos> plainAir = PlaceableStudioGeometry.requiredAirBlocks(
                "floor", "north", "plain", false, floorOrigin);
        Set<BlockPos> occludedStone = PlaceableStudioGeometry.requiredStoneBlocks(
                "floor", "north", "occlusion", true, floorOrigin);
        Set<BlockPos> occludedAir = PlaceableStudioGeometry.requiredAirBlocks(
                "floor", "north", "occlusion", true, floorOrigin);

        assertTrue(plainAir.contains(occluder));
        assertTrue(occludedStone.contains(occluder));
        assertFalse(occludedAir.contains(occluder));
    }

    @Test
    void inactiveGeometryCoversEveryAttachmentAndContextProfile() {
        BlockPos floorOrigin = PlaceableStudioGeometry.canonicalOrigin("floor");
        BlockPos wallOrigin = PlaceableStudioGeometry.canonicalOrigin("wall");
        BlockPos ceilingOrigin = PlaceableStudioGeometry.canonicalOrigin("ceiling");
        Set<BlockPos> plainFloorAir = PlaceableStudioGeometry.requiredAirBlocks(
                "floor", "north", "plain", false, floorOrigin);

        assertEquals(30, PlaceableStudioGeometry.attachmentBlocks(
                        "wall", "north", wallOrigin)
                .size());
        assertEquals(25, PlaceableStudioGeometry.attachmentBlocks(
                        "ceiling", "north", ceilingOrigin)
                .size());
        assertEquals(40, PlaceableStudioGeometry.contextBlocks(
                        "corner", false, floorOrigin)
                .size());
        assertEquals(13, PlaceableStudioGeometry.contextBlocks(
                        "doorway", false, floorOrigin)
                .size());
        assertEquals(1, PlaceableStudioGeometry.contextBlocks(
                        "occlusion", true, floorOrigin)
                .size());

        assertTrue(plainFloorAir.contains(wallOrigin.south()));
        assertTrue(plainFloorAir.contains(ceilingOrigin.above()));
        assertTrue(plainFloorAir.contains(floorOrigin.offset(3, 0, 0)));
        assertTrue(plainFloorAir.contains(floorOrigin.offset(-2, 0, 0)));
    }

    @Test
    void activeOverlapsAreNeverMisclassifiedAsStaleGeometry() {
        BlockPos ceilingOrigin = PlaceableStudioGeometry.canonicalOrigin("ceiling");
        Set<BlockPos> required = PlaceableStudioGeometry.requiredStoneBlocks(
                "ceiling", "east", "doorway", false, ceilingOrigin);
        Set<BlockPos> air = PlaceableStudioGeometry.requiredAirBlocks(
                "ceiling", "east", "doorway", false, ceilingOrigin);

        assertTrue(required.contains(ceilingOrigin.offset(-2, 1, 0)));
        assertFalse(air.contains(ceilingOrigin.offset(-2, 1, 0)));
        assertTrue(required.stream().noneMatch(air::contains));
    }
}
