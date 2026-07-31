package io.github.rithwikbabu.packwright.capture;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/** Exact ordinary-block geometry used by protocol-v3 placeable fixtures. */
final class PlaceableStudioGeometry {
    private static final List<String> ATTACHMENTS = List.of("floor", "wall", "ceiling");
    private static final List<String> ORIENTATIONS = List.of("north", "east", "south", "west");
    private static final List<String> CONTEXTS = List.of("corner", "doorway", "occlusion");

    private PlaceableStudioGeometry() {}

    static BlockPos canonicalOrigin(String attachment) {
        return switch (attachment) {
            case "floor" -> new BlockPos(0, 80, 5);
            case "wall" -> new BlockPos(0, 82, 5);
            case "ceiling" -> new BlockPos(0, 83, 5);
            default -> throw new IllegalStateException(
                    "Unsupported placeable attachment escaped protocol validation.");
        };
    }

    static Set<BlockPos> attachmentBlocks(
            String attachment, String orientation, BlockPos origin) {
        LinkedHashSet<BlockPos> result = new LinkedHashSet<>();
        switch (attachment) {
            case "floor" -> { }
            case "wall" -> {
                BlockPos behind = origin.relative(oppositeHorizontal(orientation));
                for (int offset = -2; offset <= 2; offset++) {
                    for (int y = origin.getY() - 2; y <= origin.getY() + 3; y++) {
                        BlockPos position = orientation.equals("north")
                                        || orientation.equals("south")
                                ? behind.offset(offset, y - origin.getY(), 0)
                                : behind.offset(0, y - origin.getY(), offset);
                        result.add(position);
                    }
                }
            }
            case "ceiling" -> {
                for (int x = -2; x <= 2; x++) {
                    for (int z = -2; z <= 2; z++) {
                        result.add(origin.offset(x, 1, z));
                    }
                }
            }
            default -> throw new IllegalStateException(
                    "Unsupported placeable attachment escaped protocol validation.");
        }
        return immutable(result);
    }

    static Set<BlockPos> contextBlocks(
            String context, boolean occluded, BlockPos origin) {
        if (occluded != context.equals("occlusion")) {
            throw new IllegalStateException(
                    "Placeable occlusion flag lost its exact context binding.");
        }
        LinkedHashSet<BlockPos> result = new LinkedHashSet<>();
        switch (context) {
            case "plain" -> { }
            case "corner" -> {
                for (int y = origin.getY(); y <= origin.getY() + 3; y++) {
                    for (int offset = -2; offset <= 2; offset++) {
                        result.add(origin.offset(3, y - origin.getY(), offset));
                        result.add(origin.offset(offset, y - origin.getY(), 3));
                    }
                }
            }
            case "doorway" -> {
                for (int y = origin.getY(); y <= origin.getY() + 4; y++) {
                    result.add(origin.offset(-2, y - origin.getY(), 0));
                    result.add(origin.offset(2, y - origin.getY(), 0));
                }
                for (int x = -2; x <= 2; x++) {
                    result.add(origin.offset(x, 4, 0));
                }
            }
            case "occlusion" -> result.add(origin.north(2));
            default -> throw new IllegalStateException(
                    "Unsupported placeable context escaped protocol validation.");
        }
        return immutable(result);
    }

    static Set<BlockPos> requiredStoneBlocks(
            String attachment,
            String orientation,
            String context,
            boolean occluded,
            BlockPos origin) {
        LinkedHashSet<BlockPos> result = new LinkedHashSet<>();
        result.addAll(attachmentBlocks(attachment, orientation, origin));
        result.addAll(contextBlocks(context, occluded, origin));
        return immutable(result);
    }

    static Set<BlockPos> requiredAirBlocks(
            String attachment,
            String orientation,
            String context,
            boolean occluded,
            BlockPos origin) {
        LinkedHashSet<BlockPos> result = allConditionalBlocks();
        result.removeAll(requiredStoneBlocks(
                attachment, orientation, context, occluded, origin));
        return immutable(result);
    }

    private static LinkedHashSet<BlockPos> allConditionalBlocks() {
        LinkedHashSet<BlockPos> result = new LinkedHashSet<>();
        for (String attachment : ATTACHMENTS) {
            BlockPos origin = canonicalOrigin(attachment);
            for (String orientation : ORIENTATIONS) {
                result.addAll(attachmentBlocks(attachment, orientation, origin));
            }
            for (String context : CONTEXTS) {
                result.addAll(contextBlocks(
                        context, context.equals("occlusion"), origin));
            }
        }
        return result;
    }

    private static Direction oppositeHorizontal(String orientation) {
        return switch (orientation) {
            case "north" -> Direction.SOUTH;
            case "east" -> Direction.WEST;
            case "south" -> Direction.NORTH;
            case "west" -> Direction.EAST;
            default -> throw new IllegalStateException(
                    "Unsupported cardinal orientation escaped protocol validation.");
        };
    }

    private static Set<BlockPos> immutable(LinkedHashSet<BlockPos> positions) {
        return Collections.unmodifiableSet(positions);
    }
}
