package io.github.rithwikbabu.packwright.capture.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.github.rithwikbabu.packwright.capture.PackwrightCaptureClient;
import io.github.rithwikbabu.packwright.capture.io.CanonicalJson;
import io.github.rithwikbabu.packwright.capture.io.Hashing;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Immutable implementation of Packwright client-capture protocol version 3. */
public record CapturePlan(
        int schemaVersion,
        String kind,
        String minecraftVersion,
        Provenance provenance,
        Studio studio,
        List<Scene> scenes,
        Execution execution,
        String planSha256) {
    public static final int MAX_PLAN_BYTES = 1_048_576;
    private static final int MAX_SCENES = 64;
    private static final int MAX_DISPLAY_NODES = 32;
    private static final int MAX_COMPONENT_VALUE_BYTES = 128 * 1024;
    private static final int MAX_COMPONENTS_BYTES = 512 * 1024;
    private static final Pattern SAFE_ID = Pattern.compile("[a-z0-9][a-z0-9_-]{0,63}");
    private static final Pattern EXECUTION_ID =
            Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final Pattern RESOURCE_ID =
            Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");
    private static final Pattern PROPERTY_NAME = Pattern.compile("[a-z][a-z0-9_]{0,63}");
    private static final Pattern PROPERTY_VALUE = Pattern.compile("[a-z0-9_-]{1,128}");
    private static final Pattern MOD_ID = Pattern.compile("[a-z][a-z0-9_-]{1,63}");
    private static final Pattern VERSION = Pattern.compile("[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}");
    private static final Pattern SHA1 = Pattern.compile("[0-9a-f]{40}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final Set<String> SUPPORTED_NATIVE_ENTITIES = Set.of(
            "minecraft:armor_stand",
            "minecraft:cat",
            "minecraft:chicken",
            "minecraft:cow",
            "minecraft:frog",
            "minecraft:pig",
            "minecraft:sheep",
            "minecraft:wolf",
            "minecraft:zombie");
    private static final Set<String> VARIANT_ENTITIES = Set.of(
            "minecraft:cat",
            "minecraft:chicken",
            "minecraft:cow",
            "minecraft:frog",
            "minecraft:pig",
            "minecraft:wolf");
    private static final Set<String> EQUIPMENT_SLOTS = Set.of(
            "head", "chest", "legs", "feet", "mainhand", "offhand");
    private static final Set<String> MEASUREMENT_METRICS = Set.of(
            "adjacency_seam",
            "alpha_order_artifacts",
            "animation_stability",
            "armor_stand_alignment",
            "attachment_gap",
            "billboard_correctness",
            "self_intersection",
            "face_eye_clearance",
            "first_person_obstruction",
            "collision_interaction_footprint_delta",
            "frame_retention",
            "head_penetration",
            "hitbox_containment",
            "hitbox_empty_space",
            "interpolation_determinism",
            "lighting_separation",
            "overlay_coverage",
            "orientation_alignment",
            "pairwise_pixel_delta",
            "player_scale",
            "screen_coverage",
            "silhouette_grounding",
            "variant_fit_delta",
            "texture_variant_resolution",
            "unexpected_culling",
            "visibility_occlusion",
            "visible_faces",
            "z_fighting");
    private static final Set<String> MEASUREMENT_UNITS =
            Set.of("percent", "pixels", "ratio", "count", "dot");
    private static final Set<String> READINESS_MEASUREMENT_METRICS = Set.of(
            "animation_stability",
            "lighting_separation",
            "pairwise_pixel_delta",
            "texture_variant_resolution");

    public enum Camera {
        FIRST_PERSON("first_person"),
        THIRD_PERSON_BACK("third_person_back"),
        THIRD_PERSON_FRONT("third_person_front"),
        NEUTRAL("neutral");

        private final String id;

        Camera(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum ViewKind {
        MINECRAFT_VANILLA("minecraft_vanilla"),
        FIRST_PERSON_VANILLA("first_person_vanilla"),
        FIRST_PERSON_SCALE_REFERENCE("first_person_scale_reference"),
        DEBUG_HITBOX_REFERENCE("debug_hitbox_reference"),
        COMPARISON_REFERENCE("comparison_reference"),
        WORLD_SCALE_REFERENCE("world_scale_reference"),
        MEASUREMENT_CONTROL("measurement_control");

        private final String id;

        ViewKind(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum TargetKind {
        HELD_ITEM("held_item"),
        GUI_ITEM("gui_item"),
        BLOCK("block"),
        HEADWEAR("headwear"),
        ENTITY("entity"),
        PLACEABLE("placeable");

        private final String id;

        TargetKind(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum RepresentationStrategy {
        ITEM_STACK("item_stack"),
        NATIVE_BLOCK_STATE("native_block_state"),
        BLOCK_DISPLAY("block_display"),
        EQUIPPABLE_HEAD("equippable_head"),
        NATIVE_ENTITY("native_entity"),
        DISPLAY_RIG("display_rig"),
        NATIVE_PLACEABLE_BLOCK("native_placeable_block"),
        NATIVE_PLACEABLE_ENTITY("native_placeable_entity");

        private final String id;

        RepresentationStrategy(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum Capability {
        NATIVE("native"),
        REPLACEMENT("replacement"),
        SIMULATED("simulated");

        private final String id;

        Capability(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum Context {
        WORLD("world"),
        INVENTORY("inventory"),
        HOTBAR("hotbar"),
        TOOLTIP("tooltip"),
        ITEM_INSPECTION("item_inspection");

        private final String id;

        Context(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum Hand {
        RIGHT("right"),
        LEFT("left");

        private final String id;

        Hand(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum PlayerModel {
        STEVE("steve"),
        ALEX("alex");

        private final String id;

        PlayerModel(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum AnimationState {
        IDLE("idle"),
        SWING("swing"),
        USE("use"),
        FIRE("fire"),
        AIM("aim"),
        RELEASE("release"),
        IMPACT("impact");

        private final String id;

        AnimationState(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public record ClientArtifact(String jarSha1, String jarSha256) {}

    public record CaptureMod(String id, String version, String sha256) {}

    public record ItemStackSpec(String itemId, int count, Map<String, String> components) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("itemId", itemId);
            result.put("count", count);
            result.put("components", components);
            return result;
        }
    }

    public record BlockStateSpec(String id, Map<String, String> properties) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("id", id, "properties", properties);
        }

        public String commandSyntax() {
            if (properties.isEmpty()) return id;
            String values = properties.entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .map(entry -> entry.getKey() + '=' + entry.getValue())
                    .collect(java.util.stream.Collectors.joining(","));
            return id + '[' + values + ']';
        }
    }

    public record Vec3(double x, double y, double z) {
        public List<Double> toProtocolValue() {
            return List.of(x, y, z);
        }
    }

    public record Transform(
            Vec3 translation,
            Vec3 leftRotation,
            Vec3 scale,
            Vec3 rightRotation) {
        public Map<String, Object> toProtocolValue() {
            return Map.of(
                    "translation", translation.toProtocolValue(),
                    "leftRotation", leftRotation.toProtocolValue(),
                    "scale", scale.toProtocolValue(),
                    "rightRotation", rightRotation.toProtocolValue());
        }
    }

    public record Brightness(int block, int sky) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("block", block, "sky", sky);
        }
    }

    public record Shadow(double radius, double strength) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("radius", radius, "strength", strength);
        }
    }

    public record Interpolation(int duration, int startDelta) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("duration", duration, "startDelta", startDelta);
        }
    }

    public record DisplayNode(
            String id,
            String kind,
            Vec3 position,
            double yaw,
            double pitch,
            Transform transform,
            String billboard,
            Brightness brightness,
            Shadow shadow,
            Interpolation interpolation,
            BlockStateSpec blockState,
            ItemStackSpec itemStack,
            String itemDisplayContext) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", id);
            result.put("kind", kind);
            result.put("position", position.toProtocolValue());
            result.put("yaw", yaw);
            result.put("pitch", pitch);
            result.put("transform", transform.toProtocolValue());
            result.put("billboard", billboard);
            result.put("brightness", brightness.toProtocolValue());
            result.put("shadow", shadow.toProtocolValue());
            result.put("interpolation", interpolation.toProtocolValue());
            if (blockState != null) result.put("blockState", blockState.toProtocolValue());
            if (itemStack != null) result.put("itemStack", itemStack.toProtocolValue());
            if (itemDisplayContext != null) result.put("itemDisplayContext", itemDisplayContext);
            return Map.copyOf(result);
        }
    }

    public record InteractionSpec(Vec3 position, double width, double height, boolean response) {
        public Map<String, Object> toProtocolValue() {
            return Map.of(
                    "position", position.toProtocolValue(),
                    "width", width,
                    "height", height,
                    "response", response);
        }
    }

    public record DisplayRig(List<DisplayNode> nodes, InteractionSpec interaction) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("nodes", nodes.stream().map(DisplayNode::toProtocolValue).toList());
            if (interaction != null) result.put("interaction", interaction.toProtocolValue());
            return Map.copyOf(result);
        }
    }

    public record EntitySpec(
            String entityType,
            String variant,
            boolean baby,
            Map<String, ItemStackSpec> equipment) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("entityType", entityType);
            if (variant != null) result.put("variant", variant);
            result.put("baby", baby);
            Map<String, Object> items = new LinkedHashMap<>();
            equipment.forEach((slot, stack) -> items.put(slot, stack.toProtocolValue()));
            result.put("equipment", Map.copyOf(items));
            return Map.copyOf(result);
        }
    }

    public record HeadwearSpec(String renderMode, String cameraOverlay) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("renderMode", renderMode);
            if (cameraOverlay != null) result.put("cameraOverlay", cameraOverlay);
            return Map.copyOf(result);
        }
    }

    public record RepresentationState(
            ItemStackSpec itemStack,
            BlockStateSpec blockState,
            EntitySpec entity,
            DisplayRig displayRig,
            DisplayNode blockDisplay) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            if (itemStack != null) result.put("itemStack", itemStack.toProtocolValue());
            if (blockState != null) result.put("blockState", blockState.toProtocolValue());
            if (entity != null) result.put("entity", entity.toProtocolValue());
            if (displayRig != null) result.put("displayRig", displayRig.toProtocolValue());
            if (blockDisplay != null) result.put("blockDisplay", blockDisplay.toProtocolValue());
            return Map.copyOf(result);
        }
    }

    public record PlacementState(String orientation, String attachment, String stateId) {
        public Map<String, Object> toProtocolValue() {
            return Map.of(
                    "orientation", orientation,
                    "attachment", attachment,
                    "stateId", stateId);
        }
    }

    public record Review(
            TargetKind targetKind,
            ItemStackSpec inventoryItemStack,
            boolean transparency,
            List<String> biomeTintBiomes,
            List<Integer> animatedTextureTicks,
            boolean wideFov,
            boolean armorStand,
            ItemStackSpec chestArmorItemStack,
            Map<String, String> statePoses,
            boolean lowLight,
            List<Integer> animationTicks,
            Map<String, String> poseStates,
            List<String> orientations,
            List<String> attachments,
            List<PlacementState> placementStates) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            switch (targetKind) {
                case BLOCK -> {
                    if (inventoryItemStack != null) {
                        result.put("inventoryItemStack", inventoryItemStack.toProtocolValue());
                    }
                    result.put("transparency", transparency);
                    result.put("biomeTintBiomes", biomeTintBiomes);
                    result.put("animatedTextureTicks", animatedTextureTicks);
                }
                case HEADWEAR -> {
                    result.put("wideFov", wideFov);
                    result.put("armorStand", armorStand);
                    if (chestArmorItemStack != null) {
                        result.put("chestArmorItemStack", chestArmorItemStack.toProtocolValue());
                    }
                    result.put("statePoses", statePoses);
                }
                case ENTITY -> {
                    result.put("lowLight", lowLight);
                    result.put("animationTicks", animationTicks);
                    if (!poseStates.isEmpty()) result.put("poseStates", poseStates);
                }
                case PLACEABLE -> {
                    result.put("orientations", orientations);
                    result.put("attachments", attachments);
                    result.put("placementStates", placementStates.stream()
                            .map(PlacementState::toProtocolValue)
                            .toList());
                }
                default -> throw new IllegalStateException("Item representations have no target review metadata.");
            }
            return Map.copyOf(result);
        }
    }

    public record Representation(
            TargetKind targetKind,
            RepresentationStrategy strategy,
            Capability capability,
            Map<String, RepresentationState> states,
            HeadwearSpec headwear,
            Review review) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("targetKind", targetKind.id());
            result.put("strategy", strategy.id());
            result.put("capability", capability.id());
            Map<String, Object> stateValues = new LinkedHashMap<>();
            states.forEach((id, state) -> stateValues.put(id, state.toProtocolValue()));
            result.put("states", Map.copyOf(stateValues));
            if (headwear != null) result.put("headwear", headwear.toProtocolValue());
            if (review != null) result.put("review", review.toProtocolValue());
            return Map.copyOf(result);
        }

        public String sha256() {
            return Hashing.sha256(CanonicalJson.encode(toProtocolValue()));
        }

        public boolean usesDisplayEntities() {
            return strategy == RepresentationStrategy.BLOCK_DISPLAY
                    || strategy == RepresentationStrategy.DISPLAY_RIG;
        }

        public ItemStackSpec primaryItemStack() {
            for (RepresentationState state : states.values()) {
                if (state.itemStack() != null) return state.itemStack();
                if (state.displayRig() != null) {
                    for (DisplayNode node : state.displayRig().nodes()) {
                        if (node.itemStack() != null) return node.itemStack();
                    }
                }
            }
            return null;
        }

        public RepresentationState state(String id) {
            return states.get(id);
        }
    }

    public record Studio(
            String preset,
            String rendererBackend,
            int renderDistance,
            int simulationDistance,
            String graphicsMode,
            String clouds,
            String particles,
            boolean entityShadows,
            boolean viewBobbing,
            boolean debugUi,
            BlockStateSpec floorBlock,
            BlockStateSpec backdropBlock,
            StudioScaleReference scaleReference) {
        public Map<String, Object> toProtocolValue() {
            return Map.ofEntries(
                    Map.entry("preset", preset),
                    Map.entry("rendererBackend", rendererBackend),
                    Map.entry("renderDistance", renderDistance),
                    Map.entry("simulationDistance", simulationDistance),
                    Map.entry("graphicsMode", graphicsMode),
                    Map.entry("clouds", clouds),
                    Map.entry("particles", particles),
                    Map.entry("entityShadows", entityShadows),
                    Map.entry("viewBobbing", viewBobbing),
                    Map.entry("debugUi", debugUi),
                    Map.entry("floorBlock", floorBlock.toProtocolValue()),
                    Map.entry("backdropBlock", backdropBlock.toProtocolValue()),
                    Map.entry("scaleReference", scaleReference.toProtocolValue()));
        }

        public String sha256() {
            return Hashing.sha256(CanonicalJson.encode(toProtocolValue()));
        }
    }

    public record StudioScaleReference(
            String kind,
            BlockPosition origin,
            int lengthBlocks,
            BlockStateSpec firstBlock,
            BlockStateSpec secondBlock) {
        public Map<String, Object> toProtocolValue() {
            return Map.ofEntries(
                    Map.entry("kind", kind),
                    Map.entry("origin", origin.toProtocolValue()),
                    Map.entry("lengthBlocks", lengthBlocks),
                    Map.entry("firstBlock", firstBlock.toProtocolValue()),
                    Map.entry("secondBlock", secondBlock.toProtocolValue()));
        }
    }

    public record Provenance(
            String projectId,
            String runId,
            String revisionId,
            String specSha256,
            String compiledArtifactId,
            String proposalArtifactId,
            String projectManifestSha256,
            String runtimeManifestSha256,
            String datapackContentSha256,
            String resourcepackContentSha256,
            PackActivation packActivation,
            Representation representation,
            String representationSha256,
            ClientArtifact client,
            CaptureMod captureMod) {}

    public record PackActivation(String datapack, String resourcepack) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("datapack", datapack, "resourcepack", resourcepack);
        }
    }

    public record Resolution(int width, int height) {}

    public record CameraPose(double x, double y, double z, double yaw, double pitch) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("x", x, "y", y, "z", z, "yaw", yaw, "pitch", pitch);
        }
    }

    public record Environment(
            String biome,
            int time,
            String weather,
            String lightProfile,
            int skyLight,
            int blockLight,
            LightSource lightSource) {
        public Map<String, Object> toProtocolValue() {
            return Map.ofEntries(
                    Map.entry("biome", biome),
                    Map.entry("time", time),
                    Map.entry("weather", weather),
                    Map.entry("lightProfile", lightProfile),
                    Map.entry("skyLight", skyLight),
                    Map.entry("blockLight", blockLight),
                    Map.entry("lightSource", lightSource.toProtocolValue()));
        }
    }

    public record LightSource(int level, BlockPosition offset) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("level", level, "offset", offset.toProtocolValue());
        }
    }

    public record BlockPosition(int x, int y, int z) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("x", x, "y", y, "z", z);
        }
    }

    public record Fixture(
            String kind,
            String fixtureTargetKind,
            String stateId,
            String layout,
            String backdrop,
            int overlapCopies,
            String orientation,
            String attachment,
            String pose,
            String subject,
            String framing,
            String distance,
            String context,
            String viewAngle,
            boolean showPlayerScale,
            boolean occluded,
            int angle,
            int animationTick,
            int subjectYaw,
            double cameraDistance,
            boolean chestArmor,
            BlockPosition subjectPosition,
            BlockPosition blockPosition) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("kind", kind);
            result.put("stateId", stateId);
            if (fixtureTargetKind != null) result.put("targetKind", fixtureTargetKind);
            switch (kind) {
                case "item_stack" -> { }
                case "native_block_state", "block_display" -> {
                    result.put("layout", layout);
                    result.put("backdrop", backdrop);
                    result.put("overlapCopies", overlapCopies);
                    result.put("orientation", orientation);
                    result.put("animationTick", animationTick);
                    result.put("blockPosition", blockPosition.toProtocolValue());
                }
                case "equippable_head" -> {
                    result.put("subject", subject);
                    result.put("framing", framing);
                    result.put("pose", pose);
                    result.put("subjectYaw", subjectYaw);
                    result.put("viewAngle", viewAngle);
                    result.put("cameraDistance", cameraDistance);
                    result.put("chestArmor", chestArmor);
                }
                case "native_entity" -> {
                    result.put("pose", pose);
                    result.put("angle", angle);
                    result.put("showPlayerScale", showPlayerScale);
                    result.put("animationTick", animationTick);
                }
                case "native_placeable_block", "native_placeable_entity" -> {
                    result.put("orientation", orientation);
                    result.put("attachment", attachment);
                    result.put("distance", distance);
                    result.put("occluded", occluded);
                    result.put("animationTick", animationTick);
                    result.put("context", context);
                    result.put("subjectPosition", subjectPosition.toProtocolValue());
                }
                case "display_rig" -> {
                    if ("entity".equals(fixtureTargetKind)) {
                        result.put("pose", pose);
                        result.put("angle", angle);
                        result.put("showPlayerScale", showPlayerScale);
                        result.put("animationTick", animationTick);
                    } else if ("placeable".equals(fixtureTargetKind)) {
                        result.put("orientation", orientation);
                        result.put("attachment", attachment);
                        result.put("distance", distance);
                        result.put("occluded", occluded);
                        result.put("animationTick", animationTick);
                        result.put("context", context);
                        result.put("subjectPosition", subjectPosition.toProtocolValue());
                    } else {
                        throw new IllegalStateException("Display fixture has no target-kind discriminator.");
                    }
                }
                case "measurement_control" -> {
                    result.put("targetKind", fixtureTargetKind);
                    result.put("control", "empty_subject");
                }
                default -> throw new IllegalStateException("Unknown fixture strategy: " + kind);
            }
            return Map.copyOf(result);
        }
    }

    public record MeasurementThreshold(String comparison, double warning, double failure) {
        public Map<String, Object> toProtocolValue() {
            return Map.of("comparison", comparison, "warning", warning, "failure", failure);
        }
    }

    public record MeasurementIntent(
            String id,
            String metric,
            String authority,
            String unit,
            boolean requiredForReadiness,
            MeasurementThreshold threshold,
            List<String> sourceSceneIds) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", id);
            result.put("metric", metric);
            result.put("authority", authority);
            result.put("unit", unit);
            result.put("requiredForReadiness", requiredForReadiness);
            if (threshold != null) result.put("threshold", threshold.toProtocolValue());
            if (sourceSceneIds != null) result.put("sourceSceneIds", sourceSceneIds);
            return Map.copyOf(result);
        }
    }

    /** Null means the optional presentation object was absent; an empty map was present. */
    public record Scene(
            String id,
            String baseSceneId,
            ViewKind viewKind,
            boolean requiredForAuthority,
            TargetKind targetKind,
            String representationSha256,
            Camera camera,
            Context context,
            Hand hand,
            PlayerModel playerModel,
            int fov,
            Resolution resolution,
            int guiScale,
            AnimationState animationState,
            int frame,
            String cameraPoseSemantics,
            CameraPose cameraPose,
            CameraPose expectedRenderCameraPose,
            Environment environment,
            int settlingTicks,
            Fixture fixture,
            List<MeasurementIntent> measurementIntents,
            List<String> comparisonSceneIds,
            Map<String, Object> presentation) {
        public int width() {
            return resolution.width();
        }

        public int height() {
            return resolution.height();
        }

        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", id);
            result.put("baseSceneId", baseSceneId);
            result.put("viewKind", viewKind.id());
            result.put("requiredForAuthority", requiredForAuthority);
            result.put("targetKind", targetKind.id());
            result.put("representationSha256", representationSha256);
            result.put("camera", camera.id());
            result.put("context", context.id());
            result.put("hand", hand.id());
            result.put("playerModel", playerModel.id());
            result.put("fov", fov);
            result.put("resolution", Map.of("width", width(), "height", height()));
            result.put("guiScale", guiScale);
            result.put("animationState", animationState.id());
            result.put("frame", frame);
            result.put("cameraPoseSemantics", cameraPoseSemantics);
            result.put("cameraPose", cameraPose.toProtocolValue());
            result.put("expectedRenderCameraPose", expectedRenderCameraPose.toProtocolValue());
            result.put("environment", environment.toProtocolValue());
            result.put("settlingTicks", settlingTicks);
            result.put("fixture", fixture.toProtocolValue());
            result.put("measurementIntents", measurementIntents.stream()
                    .map(MeasurementIntent::toProtocolValue)
                    .toList());
            result.put("comparisonSceneIds", comparisonSceneIds);
            if (presentation != null) result.put("presentation", presentation);
            return result;
        }

        public String sha256() {
            return Hashing.sha256(CanonicalJson.encode(toProtocolValue()));
        }

        public String appliedFixtureSha256(Representation representation) {
            RepresentationState state = representation.state(fixture.stateId());
            if (state == null
                    || representation.targetKind() != targetKind
                    || (!fixture.kind().equals("measurement_control")
                            && !representation.strategy().id().equals(fixture.kind()))) {
                throw new IllegalStateException(
                        "Cannot hash a fixture outside its exact representation binding.");
            }
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("targetKind", representation.targetKind().id());
            value.put("strategy", fixture.kind());
            value.put("capability", representation.capability().id());
            value.put("stateId", fixture.stateId());
            value.put("representationState", state.toProtocolValue());
            value.put("sceneFixture", fixture.toProtocolValue());
            if (presentation != null) value.put("scenePresentation", presentation);
            if (representation.review() != null) {
                value.put("review", representation.review().toProtocolValue());
            }
            if (representation.strategy() == RepresentationStrategy.EQUIPPABLE_HEAD) {
                value.put("headwear", representation.headwear().toProtocolValue());
            }
            return Hashing.sha256(CanonicalJson.encode(value));
        }

        public int stackCount(int fallback) {
            if (presentation == null) return fallback;
            Object value = presentation.get("stackCount");
            return value instanceof Integer count ? count : fallback;
        }

        public boolean presentationFlag(String name, boolean fallback) {
            if (presentation == null) return fallback;
            Object value = presentation.get(name);
            return value instanceof Boolean flag ? flag : fallback;
        }

        public Double durabilityFraction() {
            if (presentation == null) return null;
            Object value = presentation.get("durabilityFraction");
            return value instanceof Double fraction ? fraction : null;
        }

        public boolean referenceArm() {
            return presentationFlag("referenceArm", false);
        }

        public String referenceArmPurpose() {
            if (presentation == null) return null;
            Object value = presentation.get("referenceArmPurpose");
            return value instanceof String purpose ? purpose : null;
        }

        public Map<String, Object> pairingValue(boolean includePresentation) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("targetKind", targetKind.id());
            result.put("representationSha256", representationSha256);
            result.put("camera", camera.id());
            result.put("context", context.id());
            result.put("hand", hand.id());
            result.put("playerModel", playerModel.id());
            result.put("fov", fov);
            result.put("resolution", Map.of("width", width(), "height", height()));
            result.put("guiScale", guiScale);
            result.put("animationState", animationState.id());
            result.put("frame", frame);
            result.put("cameraPoseSemantics", cameraPoseSemantics);
            result.put("cameraPose", cameraPose.toProtocolValue());
            result.put("expectedRenderCameraPose", expectedRenderCameraPose.toProtocolValue());
            result.put("environment", environment.toProtocolValue());
            result.put("settlingTicks", settlingTicks);
            result.put("fixture", fixture.toProtocolValue());
            if (includePresentation && presentation != null) {
                Map<String, Object> retained = new LinkedHashMap<>(presentation);
                retained.remove("referenceArm");
                retained.remove("referenceArmPurpose");
                if (!retained.isEmpty()) result.put("presentation", Map.copyOf(retained));
            }
            return Map.copyOf(result);
        }

        public Map<String, Object> measurementPairingValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("targetKind", targetKind.id());
            result.put("representationSha256", representationSha256);
            result.put("camera", camera.id());
            result.put("context", context.id());
            result.put("hand", hand.id());
            result.put("playerModel", playerModel.id());
            result.put("fov", fov);
            result.put("resolution", Map.of("width", width(), "height", height()));
            result.put("guiScale", guiScale);
            result.put("animationState", animationState.id());
            result.put("frame", frame);
            result.put("cameraPoseSemantics", cameraPoseSemantics);
            result.put("cameraPose", cameraPose.toProtocolValue());
            result.put("expectedRenderCameraPose", expectedRenderCameraPose.toProtocolValue());
            result.put("environment", environment.toProtocolValue());
            return Map.copyOf(result);
        }
    }

    public record Execution(String executionId, String gameDirectory, String outputDirectory) {}

    public static CapturePlan read(Path path) throws ProtocolException {
        final byte[] bytes;
        try {
            long size = Files.size(path);
            if (size <= 0 || size > MAX_PLAN_BYTES) {
                throw new ProtocolException("Capture plan must be between 1 byte and 1 MiB.");
            }
            bytes = Files.readAllBytes(path);
        } catch (IOException error) {
            throw new ProtocolException("Capture plan could not be read.", error);
        }
        String text = decodeUtf8(bytes);
        JsonObject root = StrictJson.parseObject(text);
        if (!Arrays.equals(bytes, CanonicalJson.encode(root))) {
            throw new ProtocolException("Capture plan must use canonical JSON encoding.");
        }
        return parseRoot(root);
    }

    public static CapturePlan parse(String text) throws ProtocolException {
        return parseRoot(StrictJson.parseObject(text));
    }

    private static String decodeUtf8(byte[] bytes) throws ProtocolException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException error) {
            throw new ProtocolException("Capture plan must be valid UTF-8.", error);
        }
    }

    private static CapturePlan parseRoot(JsonObject root) throws ProtocolException {
        exactKeys(root, "plan", Set.of(
                "schemaVersion", "kind", "minecraftVersion", "provenance", "studio", "scenes",
                "execution", "planSha256"));
        int schemaVersion = integer(root, "schemaVersion", 3, 3);
        String kind = string(root, "kind", 1, 64);
        if (!kind.equals("packwright.client-capture-plan")) {
            throw new ProtocolException("Capture plan kind is unsupported.");
        }
        String minecraftVersion = string(root, "minecraftVersion", 1, 16);
        if (!minecraftVersion.equals("26.2")) {
            throw new ProtocolException("Capture plan must target Minecraft 26.2.");
        }
        Provenance provenance = parseProvenance(object(root, "provenance"));
        Studio studio = parseStudio(object(root, "studio"));
        List<Scene> scenes = parseScenes(array(root, "scenes"), provenance.representation());
        Execution execution = parseExecution(object(root, "execution"));
        String planSha256 = sha256(root, "planSha256");

        JsonObject stable = root.deepCopy();
        stable.remove("execution");
        stable.remove("planSha256");
        String expected = Hashing.sha256(CanonicalJson.encode(stable));
        if (!expected.equals(planSha256)) {
            throw new ProtocolException("Capture plan hash does not match its stable identity.");
        }

        return new CapturePlan(
                schemaVersion,
                kind,
                minecraftVersion,
                provenance,
                studio,
                List.copyOf(scenes),
                execution,
                planSha256);
    }

    private static Provenance parseProvenance(JsonObject value) throws ProtocolException {
        exactKeys(value, "provenance", Set.of(
                "projectId", "runId", "revisionId", "specSha256", "compiledArtifactId",
                "proposalArtifactId", "projectManifestSha256", "runtimeManifestSha256",
                "datapackContentSha256", "resourcepackContentSha256", "packActivation",
                "representation", "representationSha256", "client", "captureMod"));
        String projectId = safeId(value, "projectId");
        String runId = sha256(value, "runId");
        String revisionId = sha256(value, "revisionId");
        String specSha256 = sha256(value, "specSha256");
        String compiledArtifactId = sha256(value, "compiledArtifactId");
        String proposalArtifactId = sha256(value, "proposalArtifactId");
        String projectManifestSha256 = sha256(value, "projectManifestSha256");
        String runtimeManifestSha256 = sha256(value, "runtimeManifestSha256");
        String datapackContentSha256 = sha256(value, "datapackContentSha256");
        String resourcepackContentSha256 = sha256(value, "resourcepackContentSha256");
        PackActivation packActivation = parsePackActivation(object(value, "packActivation"));
        Representation representation = parseRepresentation(object(value, "representation"));
        String representationSha256 = sha256(value, "representationSha256");
        if (!representation.sha256().equals(representationSha256)) {
            throw new ProtocolException(
                    "Capture representation hash does not match its canonical representation.");
        }
        ClientArtifact client = parseClient(object(value, "client"));
        CaptureMod captureMod = parseCaptureMod(object(value, "captureMod"));
        return new Provenance(
                projectId,
                runId,
                revisionId,
                specSha256,
                compiledArtifactId,
                proposalArtifactId,
                projectManifestSha256,
                runtimeManifestSha256,
                datapackContentSha256,
                resourcepackContentSha256,
                packActivation,
                representation,
                representationSha256,
                client,
                captureMod);
    }

    private static PackActivation parsePackActivation(JsonObject value) throws ProtocolException {
        exactKeys(value, "packActivation", Set.of("datapack", "resourcepack"));
        String datapack = string(value, "datapack", 1, 64);
        String resourcepack = string(value, "resourcepack", 1, 64);
        if (!datapack.equals("hash_bound_not_loaded") || !resourcepack.equals("active")) {
            throw new ProtocolException(
                    "Capture pack activation must keep the project datapack hash-bound but unloaded and activate only the resource pack.");
        }
        return new PackActivation(datapack, resourcepack);
    }

    private static ItemStackSpec parseItemStack(JsonObject value) throws ProtocolException {
        exactKeys(value, "itemStack", Set.of("itemId", "count", "components"));
        String itemId = resourceId(value, "itemId");
        int count = integer(value, "count", 1, 99);
        JsonObject componentObject = object(value, "components");
        Map<String, String> components = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : componentObject.entrySet()) {
            if (!RESOURCE_ID.matcher(entry.getKey()).matches()) {
                throw new ProtocolException("Item component key is not a resource identifier.");
            }
            JsonElement element = entry.getValue();
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw new ProtocolException("Item component values must be strings.");
            }
            String component = element.getAsString();
            if (component.indexOf('\0') >= 0
                    || component.indexOf('\n') >= 0
                    || component.indexOf('\r') >= 0
                    || utf8Length(component) > MAX_COMPONENT_VALUE_BYTES) {
                throw new ProtocolException("Item component value exceeds its byte budget.");
            }
            components.put(entry.getKey(), component);
        }
        if (CanonicalJson.encode(componentObject).length > MAX_COMPONENTS_BYTES) {
            throw new ProtocolException("Item components exceed their byte budget.");
        }
        return new ItemStackSpec(itemId, count, Map.copyOf(components));
    }

    private static Representation parseRepresentation(JsonObject value) throws ProtocolException {
        TargetKind targetKind = enumValue(value, "targetKind", TargetKind.class);
        RepresentationStrategy strategy =
                enumValue(value, "strategy", RepresentationStrategy.class);
        Capability capability = enumValue(value, "capability", Capability.class);
        Set<String> expected = new HashSet<>(Set.of("targetKind", "strategy", "capability", "states"));
        if (strategy == RepresentationStrategy.EQUIPPABLE_HEAD) expected.add("headwear");
        if (targetKind == TargetKind.BLOCK
                || targetKind == TargetKind.HEADWEAR
                || targetKind == TargetKind.ENTITY
                || targetKind == TargetKind.PLACEABLE) expected.add("review");
        exactKeys(value, "representation", expected);
        validateRepresentationCombination(targetKind, strategy, capability);

        JsonObject stateObject = object(value, "states");
        if (stateObject.size() < 1 || stateObject.size() > 32) {
            throw new ProtocolException("Representation must declare between 1 and 32 states.");
        }
        if (strategy == RepresentationStrategy.ITEM_STACK && stateObject.size() != 1) {
            throw new ProtocolException(
                    "An item-stack capture requires exactly one canonical proposal-bound rendered state.");
        }
        Map<String, RepresentationState> states = new LinkedHashMap<>();
        String previous = null;
        for (Map.Entry<String, JsonElement> entry : stateObject.entrySet()) {
            String id = safeId(entry.getKey(), "representation state id");
            if (previous != null && previous.compareTo(id) >= 0) {
                throw new ProtocolException("Representation state ids must be uniquely sorted.");
            }
            if (!entry.getValue().isJsonObject()) {
                throw new ProtocolException("Every representation state must be an object.");
            }
            states.put(id, parseRepresentationState(entry.getValue().getAsJsonObject(), strategy));
            previous = id;
        }
        HeadwearSpec headwear = strategy == RepresentationStrategy.EQUIPPABLE_HEAD
                ? parseHeadwear(object(value, "headwear"))
                : null;
        Review review = expected.contains("review")
                ? parseReview(object(value, "review"), targetKind, states)
                : null;
        Representation result = new Representation(
                targetKind, strategy, capability, Map.copyOf(states), headwear, review);
        if (strategy == RepresentationStrategy.EQUIPPABLE_HEAD) {
            for (RepresentationState state : result.states().values()) {
                if (!state.itemStack().components().containsKey("minecraft:equippable")) {
                    throw new ProtocolException(
                            "Headwear states must contain the exact minecraft:equippable component.");
                }
            }
        }
        return result;
    }

    private static void validateRepresentationCombination(
            TargetKind targetKind, RepresentationStrategy strategy, Capability capability)
            throws ProtocolException {
        boolean valid = switch (strategy) {
            case ITEM_STACK -> (targetKind == TargetKind.HELD_ITEM || targetKind == TargetKind.GUI_ITEM)
                    && capability == Capability.NATIVE;
            case NATIVE_BLOCK_STATE -> targetKind == TargetKind.BLOCK
                    && capability == Capability.REPLACEMENT;
            case BLOCK_DISPLAY -> targetKind == TargetKind.BLOCK
                    && capability == Capability.SIMULATED;
            case EQUIPPABLE_HEAD -> targetKind == TargetKind.HEADWEAR
                    && (capability == Capability.NATIVE || capability == Capability.REPLACEMENT);
            case NATIVE_ENTITY -> targetKind == TargetKind.ENTITY
                    && capability == Capability.REPLACEMENT;
            case DISPLAY_RIG -> (targetKind == TargetKind.ENTITY || targetKind == TargetKind.PLACEABLE)
                    && capability == Capability.SIMULATED;
            case NATIVE_PLACEABLE_BLOCK -> targetKind == TargetKind.PLACEABLE
                    && (capability == Capability.NATIVE || capability == Capability.REPLACEMENT);
            case NATIVE_PLACEABLE_ENTITY -> targetKind == TargetKind.PLACEABLE
                    && capability == Capability.NATIVE;
        };
        if (!valid) {
            throw new ProtocolException(
                    "Representation strategy, target kind, and capability are incompatible.");
        }
    }

    private static RepresentationState parseRepresentationState(
            JsonObject value, RepresentationStrategy strategy) throws ProtocolException {
        return switch (strategy) {
            case ITEM_STACK, EQUIPPABLE_HEAD -> {
                exactKeys(value, "item representation state", Set.of("itemStack"));
                yield new RepresentationState(
                        parseItemStack(object(value, "itemStack")), null, null, null, null);
            }
            case NATIVE_BLOCK_STATE, NATIVE_PLACEABLE_BLOCK -> {
                exactKeys(value, "block representation state", Set.of("blockState"));
                yield new RepresentationState(null, blockState(value, "blockState"), null, null, null);
            }
            case NATIVE_ENTITY, NATIVE_PLACEABLE_ENTITY -> {
                exactKeys(value, "entity representation state", Set.of("entity"));
                yield new RepresentationState(
                        null, null, parseEntity(object(value, "entity")), null, null);
            }
            case BLOCK_DISPLAY -> {
                exactKeys(value, "block display representation state", Set.of("blockDisplay"));
                DisplayNode node = parseDisplayNode(object(value, "blockDisplay"));
                if (!node.kind().equals("block_display")) {
                    throw new ProtocolException("blockDisplay must be an exact block_display node.");
                }
                yield new RepresentationState(null, null, null, null, node);
            }
            case DISPLAY_RIG -> {
                exactKeys(value, "display representation state", Set.of("displayRig"));
                yield new RepresentationState(
                        null, null, null, parseDisplayRig(object(value, "displayRig")), null);
            }
        };
    }

    private static HeadwearSpec parseHeadwear(JsonObject value) throws ProtocolException {
        Set<String> required = Set.of("renderMode");
        Set<String> allowed = Set.of("renderMode", "cameraOverlay");
        if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
            throw fieldMismatch("headwear", value.keySet(), required, allowed);
        }
        String renderMode = string(value, "renderMode", 1, 32);
        if (!Set.of("fallback_item", "equipment_model").contains(renderMode)) {
            throw new ProtocolException("headwear.renderMode is unsupported.");
        }
        String cameraOverlay = value.has("cameraOverlay")
                ? resourceId(value, "cameraOverlay")
                : null;
        return new HeadwearSpec(renderMode, cameraOverlay);
    }

    private static Review parseReview(
            JsonObject value,
            TargetKind targetKind,
            Map<String, RepresentationState> states)
            throws ProtocolException {
        return switch (targetKind) {
            case BLOCK -> {
                Set<String> required = Set.of(
                        "transparency", "biomeTintBiomes", "animatedTextureTicks");
                Set<String> allowed = new HashSet<>(required);
                allowed.add("inventoryItemStack");
                if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
                    throw fieldMismatch("block review", value.keySet(), required, allowed);
                }
                List<Integer> animatedTicks = parseIntegerList(
                        array(value, "animatedTextureTicks"),
                        "animatedTextureTicks",
                        8,
                        0,
                        1_200);
                if (!animatedTicks.isEmpty()) {
                    throw new ProtocolException(
                            "Protocol v3 cannot reset Minecraft's global atlas animation phase; exact animated-texture samples are unsupported.");
                }
                yield new Review(
                        targetKind,
                        value.has("inventoryItemStack")
                                ? parseItemStack(object(value, "inventoryItemStack"))
                                : null,
                        bool(value, "transparency"),
                        parseResourceIdList(array(value, "biomeTintBiomes"), "biomeTintBiomes", 4),
                        animatedTicks,
                        false,
                        false,
                        null,
                        Map.of(),
                        false,
                        List.of(),
                        Map.of(),
                        List.of(),
                        List.of(),
                        List.of());
            }
            case HEADWEAR -> {
                Set<String> required = Set.of("wideFov", "armorStand", "statePoses");
                Set<String> allowed = new HashSet<>(required);
                allowed.add("chestArmorItemStack");
                if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
                    throw fieldMismatch("headwear review", value.keySet(), required, allowed);
                }
                JsonObject posesObject = object(value, "statePoses");
                if (!posesObject.keySet().equals(states.keySet())) {
                    throw new ProtocolException("headwear review statePoses must bind every exact state.");
                }
                Map<String, String> poses = new LinkedHashMap<>();
                String previous = null;
                for (Map.Entry<String, JsonElement> entry : posesObject.entrySet()) {
                    String id = safeId(entry.getKey(), "headwear state pose id");
                    if (previous != null && previous.compareTo(id) >= 0) {
                        throw new ProtocolException("headwear statePoses must be uniquely sorted.");
                    }
                    if (!entry.getValue().isJsonPrimitive()
                            || !entry.getValue().getAsJsonPrimitive().isString()) {
                        throw new ProtocolException("headwear statePoses values must be strings.");
                    }
                    String pose = entry.getValue().getAsString();
                    if (!Set.of("idle", "walk", "crouch", "swim", "glide").contains(pose)) {
                        throw new ProtocolException("headwear statePoses contains an unsupported pose.");
                    }
                    poses.put(id, pose);
                    previous = id;
                }
                boolean armorStand = bool(value, "armorStand");
                if (!armorStand) {
                    throw new ProtocolException(
                            "Supported equippable headwear requires authoritative armor-stand front and side review.");
                }
                yield new Review(
                        targetKind,
                        null,
                        false,
                        List.of(),
                        List.of(),
                        bool(value, "wideFov"),
                        true,
                        value.has("chestArmorItemStack")
                                ? parseItemStack(object(value, "chestArmorItemStack"))
                                : null,
                        Map.copyOf(poses),
                        false,
                        List.of(),
                        Map.of(),
                        List.of(),
                        List.of(),
                        List.of());
            }
            case ENTITY -> {
                Set<String> required = Set.of("lowLight", "animationTicks");
                Set<String> allowed = new HashSet<>(required);
                allowed.add("poseStates");
                if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
                    throw fieldMismatch("entity review", value.keySet(), required, allowed);
                }
                Map<String, String> poseStates = value.has("poseStates")
                        ? parseEntityPoseStates(object(value, "poseStates"), states)
                        : Map.of();
                if (states.values().stream().anyMatch(state -> state.displayRig() != null)
                        && poseStates.isEmpty()) {
                    throw new ProtocolException(
                            "Simulated entity rigs require exact idle/walk/attack state bindings.");
                }
                yield new Review(
                        targetKind,
                        null,
                        false,
                        List.of(),
                        List.of(),
                        false,
                        false,
                        null,
                        Map.of(),
                        bool(value, "lowLight"),
                        parseIntegerList(array(value, "animationTicks"), "animationTicks", 8, 0, 1_200),
                        poseStates,
                        List.of(),
                        List.of(),
                        List.of());
            }
            case PLACEABLE -> {
                exactKeys(value, "placeable review", Set.of(
                        "orientations", "attachments", "placementStates"));
                List<String> orientations = parseCanonicalStringList(
                        array(value, "orientations"),
                        "orientations",
                        List.of("north", "east", "south", "west"));
                List<String> attachments = parseCanonicalStringList(
                        array(value, "attachments"),
                        "attachments",
                        List.of("floor", "wall", "ceiling"));
                if (orientations.isEmpty() || attachments.isEmpty()) {
                    throw new ProtocolException("Placeable review matrices must not be empty.");
                }
                List<PlacementState> placements = parsePlacementStates(
                        array(value, "placementStates"), states, orientations, attachments);
                yield new Review(
                        targetKind,
                        null,
                        false,
                        List.of(),
                        List.of(),
                        false,
                        false,
                        null,
                        Map.of(),
                        false,
                        List.of(),
                        Map.of(),
                        orientations,
                        attachments,
                        placements);
            }
            default -> throw new ProtocolException("Item representations must not declare target review metadata.");
        };
    }

    private static Map<String, String> parseEntityPoseStates(
            JsonObject value, Map<String, RepresentationState> states) throws ProtocolException {
        exactKeys(value, "entity poseStates", Set.of("idle", "walk", "attack"));
        Map<String, String> result = new LinkedHashMap<>();
        for (String pose : List.of("attack", "idle", "walk")) {
            JsonElement element = value.get(pose);
            if (element == null
                    || !element.isJsonPrimitive()
                    || !element.getAsJsonPrimitive().isString()) {
                throw new ProtocolException("entity poseStates values must be state-id strings.");
            }
            String stateId = safeId(element.getAsString(), "entity pose state id");
            if (!states.containsKey(stateId)) {
                throw new ProtocolException(
                        "Entity pose state selects an undeclared representation state.");
            }
            result.put(pose, stateId);
        }
        return Map.copyOf(result);
    }

    private static List<PlacementState> parsePlacementStates(
            JsonArray values,
            Map<String, RepresentationState> states,
            List<String> orientations,
            List<String> attachments)
            throws ProtocolException {
        int expectedSize = orientations.size() * attachments.size();
        if (values.size() != expectedSize || values.isEmpty() || values.size() > 12) {
            throw new ProtocolException(
                    "Placeable review must bind every orientation/attachment pair exactly once.");
        }
        List<String> expectedOrder = new ArrayList<>();
        Set<String> expected = new HashSet<>();
        for (String orientation : orientations) {
            for (String attachment : attachments) {
                String key = orientation + '/' + attachment;
                expectedOrder.add(key);
                expected.add(key);
            }
        }
        Set<String> seen = new HashSet<>();
        List<PlacementState> result = new ArrayList<>();
        for (JsonElement element : values) {
            if (!element.isJsonObject()) {
                throw new ProtocolException("Every placeable placement state must be an object.");
            }
            JsonObject value = element.getAsJsonObject();
            exactKeys(value, "placeable placement state", Set.of(
                    "orientation", "attachment", "stateId"));
            String orientation = oneOf(
                    value, "orientation", Set.of("north", "east", "south", "west"));
            String attachment = oneOf(
                    value, "attachment", Set.of("floor", "wall", "ceiling"));
            String stateId = safeId(value, "stateId");
            String key = orientation + '/' + attachment;
            if (!expected.contains(key)
                    || !key.equals(expectedOrder.get(result.size()))
                    || !seen.add(key)) {
                throw new ProtocolException(
                        "Placeable placement states must use canonical matrix order without duplicates.");
            }
            if (!states.containsKey(stateId)) {
                throw new ProtocolException(
                        "Placeable placement state selects an undeclared representation state.");
            }
            result.add(new PlacementState(orientation, attachment, stateId));
        }
        if (!seen.equals(expected)) {
            throw new ProtocolException(
                    "Placeable placement states do not cover the declared matrix.");
        }
        return List.copyOf(result);
    }

    private static EntitySpec parseEntity(JsonObject value) throws ProtocolException {
        Set<String> required = Set.of("entityType", "baby", "equipment");
        Set<String> allowed = Set.of("entityType", "variant", "baby", "equipment");
        if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
            throw fieldMismatch("entity", value.keySet(), required, allowed);
        }
        String entityType = resourceId(value, "entityType");
        if (!SUPPORTED_NATIVE_ENTITIES.contains(entityType)) {
            throw new ProtocolException("entity.entityType is not supported by the 26.2 capture executor.");
        }
        String variant = value.has("variant") ? resourceId(value, "variant") : null;
        if (variant != null && !VARIANT_ENTITIES.contains(entityType)) {
            throw new ProtocolException("This entity type has no supported data-driven variant binding.");
        }
        if (variant == null && VARIANT_ENTITIES.contains(entityType)) {
            throw new ProtocolException(
                    "Variant-capable native entities require an explicit data-driven variant binding.");
        }
        boolean baby = bool(value, "baby");
        if (baby && entityType.equals("minecraft:armor_stand")) {
            throw new ProtocolException("Armor stands do not support the native baby state.");
        }
        JsonObject equipmentObject = object(value, "equipment");
        if (equipmentObject.size() > EQUIPMENT_SLOTS.size()) {
            throw new ProtocolException("Entity equipment exceeds the slot budget.");
        }
        Map<String, ItemStackSpec> equipment = new LinkedHashMap<>();
        String previous = null;
        for (Map.Entry<String, JsonElement> entry : equipmentObject.entrySet()) {
            String slot = entry.getKey();
            if (!EQUIPMENT_SLOTS.contains(slot)) {
                throw new ProtocolException("Entity equipment contains an unsupported slot.");
            }
            if (previous != null && previous.compareTo(slot) >= 0) {
                throw new ProtocolException("Entity equipment slots must be uniquely sorted.");
            }
            if (!entry.getValue().isJsonObject()) {
                throw new ProtocolException("Entity equipment entries must be item-stack objects.");
            }
            equipment.put(slot, parseItemStack(entry.getValue().getAsJsonObject()));
            previous = slot;
        }
        return new EntitySpec(entityType, variant, baby, Map.copyOf(equipment));
    }

    private static DisplayRig parseDisplayRig(JsonObject value) throws ProtocolException {
        Set<String> required = Set.of("nodes");
        Set<String> allowed = Set.of("nodes", "interaction");
        if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
            throw fieldMismatch("displayRig", value.keySet(), required, allowed);
        }
        JsonArray nodeValues = array(value, "nodes");
        if (nodeValues.isEmpty() || nodeValues.size() > MAX_DISPLAY_NODES) {
            throw new ProtocolException("Display rig must contain between 1 and 32 nodes.");
        }
        List<DisplayNode> nodes = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (JsonElement element : nodeValues) {
            if (!element.isJsonObject()) throw new ProtocolException("Display nodes must be objects.");
            DisplayNode node = parseDisplayNode(element.getAsJsonObject());
            if (!ids.add(node.id())) {
                throw new ProtocolException("Display node ids must be unique.");
            }
            nodes.add(node);
        }
        InteractionSpec interaction = value.has("interaction")
                ? parseInteraction(object(value, "interaction"))
                : null;
        return new DisplayRig(List.copyOf(nodes), interaction);
    }

    private static DisplayNode parseDisplayNode(JsonObject value) throws ProtocolException {
        String kind = string(value, "kind", 1, 32);
        Set<String> common = Set.of(
                "id", "kind", "position", "yaw", "pitch", "transform", "billboard",
                "brightness", "shadow", "interpolation");
        Set<String> expected = new HashSet<>(common);
        if (kind.equals("block_display")) {
            expected.add("blockState");
        } else if (kind.equals("item_display")) {
            expected.add("itemStack");
            expected.add("itemDisplayContext");
        } else {
            throw new ProtocolException("Display node kind is unsupported.");
        }
        exactKeys(value, "display node", expected);
        String id = safeId(value, "id");
        Vec3 position = vector(
                array(value, "position"), "position", -30_000_000, 30_000_000, false);
        double yaw = decimal(value, "yaw", -360, 360);
        double pitch = decimal(value, "pitch", -90, 90);
        Transform transform = parseTransform(object(value, "transform"));
        String billboard = string(value, "billboard", 1, 16);
        if (!Set.of("fixed", "vertical", "horizontal", "center").contains(billboard)) {
            throw new ProtocolException("Display billboard is unsupported.");
        }
        JsonObject brightnessValue = object(value, "brightness");
        exactKeys(brightnessValue, "brightness", Set.of("block", "sky"));
        Brightness brightness = new Brightness(
                integer(brightnessValue, "block", 0, 15),
                integer(brightnessValue, "sky", 0, 15));
        JsonObject shadowValue = object(value, "shadow");
        exactKeys(shadowValue, "shadow", Set.of("radius", "strength"));
        Shadow shadow = new Shadow(
                decimal(shadowValue, "radius", 0, 64),
                decimal(shadowValue, "strength", 0, 1));
        JsonObject interpolationValue = object(value, "interpolation");
        exactKeys(interpolationValue, "interpolation", Set.of("duration", "startDelta"));
        Interpolation interpolation = new Interpolation(
                integer(interpolationValue, "duration", 0, 1_200),
                integer(interpolationValue, "startDelta", -1_200, 1_200));
        if (interpolation.duration() != 0 || interpolation.startDelta() != 0) {
            throw new ProtocolException(
                    "Protocol v3 accepts only static display nodes; interpolation duration and startDelta must both be zero.");
        }
        BlockStateSpec blockState =
                kind.equals("block_display") ? blockState(value, "blockState") : null;
        ItemStackSpec itemStack = kind.equals("item_display")
                ? parseItemStack(object(value, "itemStack"))
                : null;
        String itemDisplayContext = kind.equals("item_display")
                ? string(value, "itemDisplayContext", 1, 32)
                : null;
        if (itemDisplayContext != null
                && !Set.of(
                                "none", "thirdperson_lefthand", "thirdperson_righthand",
                                "firstperson_lefthand", "firstperson_righthand", "head", "gui",
                                "ground", "fixed")
                        .contains(itemDisplayContext)) {
            throw new ProtocolException("Item-display context is unsupported.");
        }
        return new DisplayNode(
                id, kind, position, yaw, pitch, transform, billboard, brightness, shadow,
                interpolation, blockState, itemStack, itemDisplayContext);
    }

    private static Transform parseTransform(JsonObject value) throws ProtocolException {
        exactKeys(value, "transform", Set.of(
                "translation", "leftRotation", "scale", "rightRotation"));
        return new Transform(
                vector(array(value, "translation"), "translation", -32, 32, false),
                vector(array(value, "leftRotation"), "leftRotation", -360, 360, false),
                vector(array(value, "scale"), "scale", 0.001, 64, true),
                vector(array(value, "rightRotation"), "rightRotation", -360, 360, false));
    }

    private static InteractionSpec parseInteraction(JsonObject value) throws ProtocolException {
        exactKeys(value, "interaction", Set.of("position", "width", "height", "response"));
        boolean response = bool(value, "response");
        if (response) {
            throw new ProtocolException("Capture interactions must be non-responsive QA fixtures.");
        }
        return new InteractionSpec(
                vector(
                        array(value, "position"),
                        "position",
                        -30_000_000,
                        30_000_000,
                        false),
                decimal(value, "width", Double.MIN_VALUE, 64),
                decimal(value, "height", Double.MIN_VALUE, 64),
                false);
    }

    private static Studio parseStudio(JsonObject value) throws ProtocolException {
        exactKeys(value, "studio", Set.of(
                "preset", "rendererBackend", "renderDistance", "simulationDistance",
                "graphicsMode", "clouds", "particles", "entityShadows", "viewBobbing",
                "debugUi", "floorBlock", "backdropBlock", "scaleReference"));
        String preset = string(value, "preset", 1, 32);
        String rendererBackend = string(value, "rendererBackend", 1, 16);
        String graphicsMode = string(value, "graphicsMode", 1, 16);
        String clouds = string(value, "clouds", 1, 16);
        String particles = string(value, "particles", 1, 16);
        boolean entityShadows = bool(value, "entityShadows");
        boolean viewBobbing = bool(value, "viewBobbing");
        boolean debugUi = bool(value, "debugUi");
        if (!preset.equals("void_matte")
                || !rendererBackend.equals("opengl")
                || !graphicsMode.equals("custom")
                || !clouds.equals("off")
                || !particles.equals("minimal")
                || !entityShadows
                || viewBobbing
                || debugUi) {
            throw new ProtocolException(
                    "Studio settings do not match the authoritative OpenGL deterministic custom profile.");
        }
        BlockStateSpec floorBlock = blockState(value, "floorBlock");
        BlockStateSpec backdropBlock = blockState(value, "backdropBlock");
        StudioScaleReference scaleReference = parseStudioScaleReference(
                object(value, "scaleReference"));
        return new Studio(
                preset,
                rendererBackend,
                integer(value, "renderDistance", 2, 16),
                integer(value, "simulationDistance", 2, 12),
                graphicsMode,
                clouds,
                particles,
                entityShadows,
                viewBobbing,
                debugUi,
                floorBlock,
                backdropBlock,
                scaleReference);
    }

    private static StudioScaleReference parseStudioScaleReference(JsonObject value)
            throws ProtocolException {
        exactKeys(value, "studio.scaleReference", Set.of(
                "kind", "origin", "lengthBlocks", "firstBlock", "secondBlock"));
        StudioScaleReference reference = new StudioScaleReference(
                string(value, "kind", 1, 64),
                parseBlockPosition(object(value, "origin")),
                integer(value, "lengthBlocks", 1, 16),
                blockState(value, "firstBlock"),
                blockState(value, "secondBlock"));
        if (!reference.kind().equals("ordinary_block_floor_ruler")
                || !reference.origin().equals(new BlockPosition(-2, 79, 7))
                || reference.lengthBlocks() != 2
                || !reference.firstBlock().equals(
                        new BlockStateSpec("minecraft:black_concrete", Map.of()))
                || !reference.secondBlock().equals(
                        new BlockStateSpec("minecraft:white_concrete", Map.of()))) {
            throw new ProtocolException(
                    "Studio scale reference must use Packwright's fixed two-block vanilla floor ruler.");
        }
        return reference;
    }

    private static ClientArtifact parseClient(JsonObject value) throws ProtocolException {
        exactKeys(value, "client", Set.of("jarSha1", "jarSha256"));
        return new ClientArtifact(sha1(value, "jarSha1"), sha256(value, "jarSha256"));
    }

    private static CaptureMod parseCaptureMod(JsonObject value) throws ProtocolException {
        exactKeys(value, "captureMod", Set.of("id", "version", "sha256"));
        String id = string(value, "id", 2, 64);
        String version = string(value, "version", 1, 64);
        if (!MOD_ID.matcher(id).matches()) throw new ProtocolException("captureMod.id is invalid.");
        if (!VERSION.matcher(version).matches()) {
            throw new ProtocolException("captureMod.version is invalid.");
        }
        if (!id.equals(PackwrightCaptureClient.MOD_ID)
                || !version.equals(PackwrightCaptureClient.MOD_VERSION)) {
            throw new ProtocolException("Capture plan requires a different capture-mod identity.");
        }
        return new CaptureMod(id, version, sha256(value, "sha256"));
    }

    private static List<Scene> parseScenes(JsonArray values, Representation representation)
            throws ProtocolException {
        if (values.isEmpty() || values.size() > MAX_SCENES) {
            throw new ProtocolException("Capture plan must contain between 1 and 64 scenes.");
        }
        List<Scene> scenes = new ArrayList<>();
        String previous = null;
        for (JsonElement element : values) {
            if (!element.isJsonObject()) throw new ProtocolException("Every scene must be an object.");
            Scene scene = parseScene(element.getAsJsonObject(), representation);
            if (previous != null && previous.compareTo(scene.id()) >= 0) {
                throw new ProtocolException("Capture scenes must be uniquely sorted by id.");
            }
            previous = scene.id();
            scenes.add(scene);
        }
        Map<String, Scene> vanillaFirstPerson = new LinkedHashMap<>();
        Map<String, Scene> vanillaWorld = new LinkedHashMap<>();
        List<Scene> measurementControls = new ArrayList<>();
        Map<String, Scene> byId = new LinkedHashMap<>();
        Set<String> measurementIds = new HashSet<>();
        for (Scene scene : scenes) {
            byId.put(scene.id(), scene);
            for (MeasurementIntent intent : scene.measurementIntents()) {
                if (!measurementIds.add(intent.id())) {
                    throw new ProtocolException("Measurement intent ids must be unique across the plan.");
                }
            }
            if (scene.viewKind() == ViewKind.FIRST_PERSON_VANILLA) {
                vanillaFirstPerson.put(scene.baseSceneId(), scene);
            } else if (scene.viewKind() == ViewKind.MINECRAFT_VANILLA) {
                vanillaWorld.put(scene.baseSceneId(), scene);
            } else if (scene.viewKind() == ViewKind.MEASUREMENT_CONTROL) {
                measurementControls.add(scene);
            }
        }
        for (Scene scene : measurementControls) {
            Scene vanilla = vanillaFirstPerson.get(scene.baseSceneId());
            if (vanilla == null) vanilla = vanillaWorld.get(scene.baseSceneId());
            if (vanilla == null
                    || !scene.measurementPairingValue().equals(vanilla.measurementPairingValue())
                    || !scene.fixture().stateId().equals(vanilla.fixture().stateId())
                    || !scene.comparisonSceneIds().equals(List.of(vanilla.id()))
                    || !vanilla.comparisonSceneIds().contains(scene.id())) {
                throw new ProtocolException(
                        "Measurement-control scene does not match its authoritative empty-subject pair: "
                                + scene.id());
            }
        }
        for (Scene scene : scenes) {
            Scene vanilla;
            if (scene.viewKind() == ViewKind.FIRST_PERSON_SCALE_REFERENCE) {
                vanilla = vanillaFirstPerson.get(scene.baseSceneId());
            } else if (scene.viewKind() == ViewKind.DEBUG_HITBOX_REFERENCE) {
                vanilla = vanillaWorld.get(scene.baseSceneId());
            } else {
                continue;
            }
            if (vanilla == null) {
                throw new ProtocolException(
                        "Augmented scene has no matching authoritative vanilla scene: " + scene.id());
            }
            boolean includePresentation =
                    scene.viewKind() == ViewKind.FIRST_PERSON_SCALE_REFERENCE;
            if (!scene.pairingValue(includePresentation)
                    .equals(vanilla.pairingValue(includePresentation))) {
                throw new ProtocolException(
                        "Augmented scene does not match its authoritative vanilla pair: " + scene.id());
            }
        }
        for (Scene scene : scenes) {
            for (String comparisonId : scene.comparisonSceneIds()) {
                Scene comparison = byId.get(comparisonId);
                if (comparison == null || comparison == scene) {
                    throw new ProtocolException(
                            "Scene comparison references a missing scene or itself: " + comparisonId);
                }
                if (comparison.targetKind() != scene.targetKind()
                        || !comparison.representationSha256().equals(scene.representationSha256())) {
                    throw new ProtocolException(
                            "Scene comparisons must use the same hash-bound representation.");
                }
            }
            for (MeasurementIntent intent : scene.measurementIntents()) {
                List<String> resolvedSourceIds = intent.sourceSceneIds() == null
                        ? java.util.stream.Stream.concat(
                                        java.util.stream.Stream.of(scene.id()),
                                        scene.comparisonSceneIds().stream())
                                .distinct()
                                .sorted()
                                .toList()
                        : intent.sourceSceneIds();
                for (String sourceId : resolvedSourceIds) {
                    Scene source = byId.get(sourceId);
                    if (source == null
                            || source.targetKind() != scene.targetKind()
                            || !source.representationSha256()
                                    .equals(scene.representationSha256())) {
                        throw new ProtocolException(
                                "Explicit measurement sources must name existing same-representation scenes.");
                    }
                    if (!sourceId.equals(scene.id())
                            && !scene.comparisonSceneIds().contains(sourceId)) {
                        throw new ProtocolException(
                            "Explicit measurement sources must be exact scene comparison bindings.");
                    }
                }
                if (intent.requiredForReadiness()) {
                    if (!scene.requiredForAuthority()) {
                        throw new ProtocolException(
                                "Readiness-critical measurements must be owned by authoritative required scenes.");
                    }
                    if (intent.threshold() == null) {
                        throw new ProtocolException(
                                "Readiness-critical measurements require calibrated thresholds.");
                    }
                    if (!READINESS_MEASUREMENT_METRICS.contains(intent.metric())) {
                        throw new ProtocolException(
                                "Measurement metric is not calibrated for capture readiness: "
                                        + intent.metric());
                    }
                    if (resolvedSourceIds.size() != 2
                            || resolvedSourceIds.stream()
                                    .map(byId::get)
                                    .anyMatch(source -> source == null
                                            || !source.requiredForAuthority())) {
                        throw new ProtocolException(
                                "Readiness-critical measurements require exactly two authoritative required framebuffer sources; supplemental controls and debug frames cannot gate readiness.");
                    }
                }
            }
            if (scene.viewKind() == ViewKind.COMPARISON_REFERENCE
                    || scene.viewKind() == ViewKind.WORLD_SCALE_REFERENCE
                    || scene.viewKind() == ViewKind.MEASUREMENT_CONTROL) {
                if (scene.comparisonSceneIds().isEmpty()
                        || scene.comparisonSceneIds().stream()
                                .map(byId::get)
                                .anyMatch(comparison -> comparison == null
                                        || !comparison.requiredForAuthority())) {
                    throw new ProtocolException(
                            "Augmented comparison/world-scale scenes require an authoritative control.");
                }
            }
        }
        if (representation.targetKind() == TargetKind.HEADWEAR) {
            requireCoreArmorStandScene(
                    byId,
                    representation,
                    "head_stand_front",
                    "front",
                    new CameraPose(0.5, 80.95, 11.5, 180, 0));
            requireCoreArmorStandScene(
                    byId,
                    representation,
                    "head_stand_side",
                    "side",
                    new CameraPose(-5.5, 80.95, 5.5, -90, 0));
        }
        return scenes;
    }

    private static void requireCoreArmorStandScene(
            Map<String, Scene> scenes,
            Representation representation,
            String id,
            String viewAngle,
            CameraPose expectedRenderCameraPose)
            throws ProtocolException {
        Scene scene = scenes.get(id);
        if (scene == null
                || scene.viewKind() != ViewKind.MINECRAFT_VANILLA
                || !scene.requiredForAuthority()
                || scene.targetKind() != TargetKind.HEADWEAR
                || scene.camera() != Camera.NEUTRAL
                || scene.context() != Context.WORLD
                || !scene.cameraPose().equals(new CameraPose(0.5, 80, 5.5, 0, 0))
                || !scene.expectedRenderCameraPose().equals(expectedRenderCameraPose)
                || !scene.fixture().kind().equals("equippable_head")
                || representation.state(scene.fixture().stateId()) == null
                || !scene.fixture().subject().equals("armor_stand")
                || !scene.fixture().framing().equals("full_body")
                || !scene.fixture().pose().equals("idle")
                || !scene.fixture().viewAngle().equals(viewAngle)
                || scene.fixture().cameraDistance() != 6
                || scene.fixture().chestArmor()) {
            throw new ProtocolException(
                    "Equippable headwear requires authoritative armor-stand front and side core scenes.");
        }
    }

    private static Scene parseScene(JsonObject value, Representation representation)
            throws ProtocolException {
        Set<String> required = Set.of(
                "id", "baseSceneId", "viewKind", "requiredForAuthority", "targetKind",
                "representationSha256", "camera", "context", "hand", "playerModel", "fov",
                "resolution", "guiScale", "animationState", "frame", "cameraPoseSemantics",
                "cameraPose", "expectedRenderCameraPose", "environment", "settlingTicks",
                "fixture", "measurementIntents", "comparisonSceneIds");
        Set<String> actual = value.keySet();
        Set<String> allowed = new HashSet<>(required);
        allowed.add("presentation");
        if (!actual.containsAll(required) || !allowed.containsAll(actual)) {
            throw fieldMismatch("scene", actual, required, allowed);
        }
        String id = safeId(value, "id");
        String baseSceneId = safeId(value, "baseSceneId");
        ViewKind viewKind = enumValue(value, "viewKind", ViewKind.class);
        boolean requiredForAuthority = bool(value, "requiredForAuthority");
        TargetKind targetKind = enumValue(value, "targetKind", TargetKind.class);
        String representationSha256 = sha256(value, "representationSha256");
        if (targetKind != representation.targetKind()
                || !representationSha256.equals(representation.sha256())) {
            throw new ProtocolException("Scene target or representation hash does not match provenance.");
        }
        Camera camera = enumValue(value, "camera", Camera.class);
        Context context = enumValue(value, "context", Context.class);
        Hand hand = enumValue(value, "hand", Hand.class);
        PlayerModel playerModel = enumValue(value, "playerModel", PlayerModel.class);
        int fov = integer(value, "fov", 30, 120);
        JsonObject resolutionObject = object(value, "resolution");
        exactKeys(resolutionObject, "resolution", Set.of("width", "height"));
        int width = integer(resolutionObject, "width", 64, 4096);
        int height = integer(resolutionObject, "height", 64, 4096);
        if ((long) width * height > 16L * 1024 * 1024) {
            throw new ProtocolException("Capture resolution exceeds the pixel budget.");
        }
        int guiScale = integer(value, "guiScale", 0, 8);
        AnimationState animation = enumValue(value, "animationState", AnimationState.class);
        int frame = integer(value, "frame", 0, 72_000);
        String cameraPoseSemantics = string(value, "cameraPoseSemantics", 1, 32);
        if (!cameraPoseSemantics.equals("player_feet_anchor")) {
            throw new ProtocolException("Capture camera pose semantics are unsupported.");
        }
        CameraPose cameraPose = parseCameraPose(object(value, "cameraPose"));
        CameraPose expectedRenderCameraPose =
                parseCameraPose(object(value, "expectedRenderCameraPose"));
        Environment environment = parseEnvironment(object(value, "environment"));
        int settlingTicks = integer(value, "settlingTicks", 0, 40);
        Fixture fixture = parseFixture(object(value, "fixture"), targetKind, representation);
        boolean measurementControlFixture = fixture.kind().equals("measurement_control");
        if (!measurementControlFixture) validateTargetContext(targetKind, context, fixture);
        if (!measurementControlFixture
                && representation.usesDisplayEntities()
                && settlingTicks < 2) {
            throw new ProtocolException("Display representations require at least two settling ticks.");
        }
        List<MeasurementIntent> measurementIntents =
                parseMeasurementIntents(array(value, "measurementIntents"));
        for (MeasurementIntent intent : measurementIntents) {
            if (intent.sourceSceneIds() != null
                    && !intent.sourceSceneIds().contains(id)) {
                throw new ProtocolException(
                        "Explicit measurement sources must include their owning scene.");
            }
        }
        List<String> comparisonSceneIds = parseSafeIdList(
                array(value, "comparisonSceneIds"), "comparisonSceneIds", 16);
        if (!measurementControlFixture) {
            validateReviewSelection(representation, fixture, environment, fov);
        }
        if ((targetKind == TargetKind.BLOCK
                        || targetKind == TargetKind.ENTITY
                        || targetKind == TargetKind.PLACEABLE)
                && context == Context.WORLD
                && !measurementControlFixture) {
            BlockPosition subject = targetKind == TargetKind.BLOCK
                    ? fixture.blockPosition()
                    : targetKind == TargetKind.PLACEABLE
                            ? fixture.subjectPosition()
                            : new BlockPosition(0, 80, 5);
            if (camera != Camera.NEUTRAL
                    || !cameraFacesSubject(expectedRenderCameraPose, subject)) {
                throw new ProtocolException(
                        "Studio camera must be neutral and face the declared subject origin.");
            }
        }
        Map<String, Object> presentation = value.has("presentation")
                ? parsePresentation(object(value, "presentation"))
                : null;
        boolean isFirstPersonWorld = context == Context.WORLD && camera == Camera.FIRST_PERSON;
        boolean isVanillaFirstPerson = viewKind == ViewKind.FIRST_PERSON_VANILLA;
        boolean isScaleReference = viewKind == ViewKind.FIRST_PERSON_SCALE_REFERENCE;
        boolean isDebugReference = viewKind == ViewKind.DEBUG_HITBOX_REFERENCE;
        boolean isComparisonReference = viewKind == ViewKind.COMPARISON_REFERENCE;
        boolean isWorldScaleReference = viewKind == ViewKind.WORLD_SCALE_REFERENCE;
        boolean isMeasurementControl = viewKind == ViewKind.MEASUREMENT_CONTROL;
        if (isFirstPersonWorld
                && targetKind == TargetKind.HELD_ITEM
                && !isVanillaFirstPerson
                && !isScaleReference) {
            throw new ProtocolException(
                    "First-person world scenes must declare a vanilla or scale-reference view kind.");
        }
        if ((!isFirstPersonWorld || targetKind != TargetKind.HELD_ITEM)
                && (isVanillaFirstPerson || isScaleReference)
                && !(targetKind == TargetKind.HEADWEAR && isVanillaFirstPerson)) {
            throw new ProtocolException(
                    "First-person view kinds are allowed only for first-person world scenes.");
        }
        String expectedId = switch (viewKind) {
            case FIRST_PERSON_VANILLA -> "first_person_vanilla--" + baseSceneId;
            case FIRST_PERSON_SCALE_REFERENCE -> "first_person_scale_reference--" + baseSceneId;
            case DEBUG_HITBOX_REFERENCE -> "debug_hitbox_reference--" + baseSceneId;
            case COMPARISON_REFERENCE -> "comparison_reference--" + baseSceneId;
            case WORLD_SCALE_REFERENCE -> "world_scale_reference--" + baseSceneId;
            case MEASUREMENT_CONTROL -> "measurement_control--" + baseSceneId;
            case MINECRAFT_VANILLA -> baseSceneId;
        };
        if (!id.equals(expectedId)) {
            throw new ProtocolException("Scene id does not match its view kind and base scene id.");
        }
        boolean augmented = isScaleReference
                || isDebugReference
                || isComparisonReference
                || isWorldScaleReference
                || isMeasurementControl;
        if (requiredForAuthority == augmented) {
            throw new ProtocolException(
                    "Vanilla scenes must be authoritative and augmented scenes supplemental.");
        }
        if (isDebugReference
                && targetKind != TargetKind.ENTITY
                && targetKind != TargetKind.PLACEABLE) {
            throw new ProtocolException("Debug hitbox scenes are allowed only for entity/placeable targets.");
        }
        if (isComparisonReference && targetKind != TargetKind.HEADWEAR) {
            throw new ProtocolException(
                    "Comparison-reference scenes are allowed only for headwear targets.");
        }
        boolean bareHeadControl = targetKind == TargetKind.HEADWEAR
                && fixture.kind().equals("equippable_head")
                && fixture.subject().equals("bare_control");
        if (bareHeadControl && !isComparisonReference) {
            throw new ProtocolException(
                    "A bare-head control is a supplemental comparison-reference scene and cannot satisfy authority.");
        }
        if (isWorldScaleReference && targetKind != TargetKind.ENTITY) {
            throw new ProtocolException(
                    "World-scale-reference scenes are allowed only for entity targets.");
        }
        boolean injectsEntityScaleMannequin = targetKind == TargetKind.ENTITY
                && !measurementControlFixture
                && fixture.showPlayerScale();
        if (isWorldScaleReference != injectsEntityScaleMannequin) {
            throw new ProtocolException(
                    "An injected entity scale mannequin is valid only in a supplemental world-scale-reference scene.");
        }
        if (isMeasurementControl
                != (fixture.kind().equals("measurement_control"))) {
            throw new ProtocolException(
                    "Measurement-control view kinds and empty-subject fixtures must match exactly.");
        }
        if (isMeasurementControl
                && (presentation != null || settlingTicks != 0)) {
            throw new ProtocolException(
                    "Measurement-control scenes cannot inject presentation content or settling delay.");
        }
        boolean hasReferenceArm = presentation != null
                && Boolean.TRUE.equals(presentation.get("referenceArm"));
        boolean hasScaleOnlyPurpose = presentation != null
                && "scale_only".equals(presentation.get("referenceArmPurpose"));
        if (isScaleReference && (!hasReferenceArm || !hasScaleOnlyPurpose)) {
            throw new ProtocolException(
                    "Scale-reference scenes require referenceArm=true and referenceArmPurpose=scale_only.");
        }
        if (!isScaleReference
                && presentation != null
                && (presentation.containsKey("referenceArm")
                        || presentation.containsKey("referenceArmPurpose"))) {
            throw new ProtocolException(
                    "Reference-arm presentation fields are allowed only for first-person scale-reference scenes.");
        }
        return new Scene(
                id,
                baseSceneId,
                viewKind,
                requiredForAuthority,
                targetKind,
                representationSha256,
                camera,
                context,
                hand,
                playerModel,
                fov,
                new Resolution(width, height),
                guiScale,
                animation,
                frame,
                cameraPoseSemantics,
                cameraPose,
                expectedRenderCameraPose,
                environment,
                settlingTicks,
                fixture,
                measurementIntents,
                comparisonSceneIds,
                presentation);
    }

    private static CameraPose parseCameraPose(JsonObject value) throws ProtocolException {
        exactKeys(value, "cameraPose", Set.of("x", "y", "z", "yaw", "pitch"));
        return new CameraPose(
                decimal(value, "x", -64, 64),
                decimal(value, "y", 64, 96),
                decimal(value, "z", -64, 64),
                decimal(value, "yaw", -360, 360),
                decimal(value, "pitch", -90, 90));
    }

    private static Environment parseEnvironment(JsonObject value) throws ProtocolException {
        exactKeys(value, "environment", Set.of(
                "biome", "time", "weather", "lightProfile", "skyLight", "blockLight",
                "lightSource"));
        String biome = resourceId(value, "biome");
        String weather = string(value, "weather", 1, 16);
        String lightProfile = string(value, "lightProfile", 1, 16);
        int time = integer(value, "time", 0, 23_999);
        int skyLight = integer(value, "skyLight", 0, 15);
        int blockLight = integer(value, "blockLight", 0, 15);
        JsonObject sourceValue = object(value, "lightSource");
        exactKeys(sourceValue, "lightSource", Set.of("level", "offset"));
        LightSource lightSource = new LightSource(
                integer(sourceValue, "level", 0, 15),
                parseOffset(object(sourceValue, "offset"), "lightSource.offset"));
        if (!weather.equals("clear")) {
            throw new ProtocolException(
                    "The 26.2 capture studio currently supports only clear-weather scenes.");
        }
        if ((lightProfile.equals("day") && (time != 6_000 || skyLight != 15 || blockLight != 0))
                || (lightProfile.equals("low")
                        && (time != 18_000 || skyLight != 15 || blockLight != 4))
                || (!lightProfile.equals("day") && !lightProfile.equals("low"))) {
            throw new ProtocolException(
                    "Environment light profile, time, sky-light, and block-light binding disagree.");
        }
        int expectedSourceLevel = lightProfile.equals("low") ? 11 : 0;
        if (lightSource.level() != expectedSourceLevel
                || !lightSource.offset().equals(new BlockPosition(0, 5, -2))) {
            throw new ProtocolException(
                    "Environment light source does not match its canonical light profile.");
        }
        return new Environment(
                biome, time, weather, lightProfile, skyLight, blockLight, lightSource);
    }

    private static BlockPosition parseOffset(JsonObject value, String name)
            throws ProtocolException {
        exactKeys(value, name, Set.of("x", "y", "z"));
        return new BlockPosition(
                integer(value, "x", -16, 16),
                integer(value, "y", -16, 16),
                integer(value, "z", -16, 16));
    }

    private static Fixture parseFixture(
            JsonObject value, TargetKind targetKind, Representation representation)
            throws ProtocolException {
        String kind = string(value, "kind", 1, 32);
        if (kind.equals("measurement_control")) {
            exactKeys(value, "measurement-control fixture", Set.of(
                    "kind", "targetKind", "stateId", "control"));
            String fixtureTarget = oneOf(value, "targetKind", Set.of(
                    "block", "headwear", "entity", "placeable"));
            if (!fixtureTarget.equals(targetKind.id())) {
                throw new ProtocolException(
                        "Measurement-control fixture targetKind does not match its scene.");
            }
            String stateId = safeId(value, "stateId");
            if (representation.state(stateId) == null) {
                throw new ProtocolException(
                        "Measurement-control fixture selects an undeclared representation state.");
            }
            if (!string(value, "control", 1, 32).equals("empty_subject")) {
                throw new ProtocolException(
                        "Measurement-control fixture must declare control=empty_subject.");
            }
            return new Fixture(
                    kind, fixtureTarget, stateId, null, null, 0, null, null, null, null,
                    null, null, null, null, false, false, 0, 0, 0, 0,
                    false, null, null);
        }
        String expectedKind = representation.strategy().id();
        if (!kind.equals(expectedKind)) {
            throw new ProtocolException("Scene fixture kind does not match its representation strategy.");
        }
        String stateId = safeId(value, "stateId");
        RepresentationState state = representation.state(stateId);
        if (state == null) {
            throw new ProtocolException("Scene fixture selects an undeclared representation state.");
        }
        Set<String> common = Set.of("kind", "stateId");
        switch (targetKind) {
            case HELD_ITEM, GUI_ITEM -> {
                exactKeys(value, "item fixture", common);
                return new Fixture(kind, null, stateId, null, null, 0, null, null, null, null, null,
                        null, null, null, false, false, 0, 0, 0, 0, false, null, null);
            }
            case BLOCK -> {
                exactKeys(value, "block fixture", Set.of(
                        "kind", "stateId", "layout", "orientation", "animationTick",
                        "blockPosition", "backdrop", "overlapCopies"));
                String layout = oneOf(value, "layout", Set.of(
                        "single", "adjacency", "culling", "inventory",
                        "transparency_light", "transparency_dark", "transparency_overlap"));
                String backdrop = oneOf(value, "backdrop", Set.of("studio", "light", "dark"));
                int overlapCopies = integer(value, "overlapCopies", 1, 2);
                boolean validTransparency = switch (layout) {
                    case "transparency_light" -> backdrop.equals("light") && overlapCopies == 1;
                    case "transparency_dark" -> backdrop.equals("dark") && overlapCopies == 1;
                    case "transparency_overlap" -> backdrop.equals("light") && overlapCopies == 2;
                    default -> backdrop.equals("studio") && overlapCopies == 1;
                };
                if (!validTransparency) {
                    throw new ProtocolException(
                            "Block layout, backdrop, and overlap-copy declaration disagree.");
                }
                String orientation = oneOf(value, "orientation", Set.of(
                        "north", "south", "east", "west", "up", "down", "three_quarter"));
                int animationTick = integer(value, "animationTick", 0, 1_200);
                BlockPosition blockPosition = parseBlockPosition(object(value, "blockPosition"));
                BlockPosition expected = orientation.equals("down")
                        ? new BlockPosition(0, 84, 5)
                        : new BlockPosition(0, 80, 5);
                if (!blockPosition.equals(expected)) {
                    throw new ProtocolException(
                            "Block fixture position does not match the deterministic face-review studio.");
                }
                return new Fixture(kind, null, stateId, layout, backdrop, overlapCopies,
                        orientation, null, null, null,
                        null, null, null, null, false, false, 0, animationTick, 0, 0,
                        false, null, blockPosition);
            }
            case HEADWEAR -> {
                exactKeys(value, "headwear fixture", Set.of(
                        "kind", "stateId", "subject", "framing", "pose", "subjectYaw",
                        "viewAngle", "cameraDistance", "chestArmor"));
                String subject = oneOf(value, "subject", Set.of("player", "armor_stand", "bare_control"));
                String framing = oneOf(value, "framing", Set.of("head", "full_body", "first_person"));
                String pose = oneOf(value, "pose", Set.of("idle", "walk", "crouch", "swim", "glide"));
                int subjectYaw = integer(value, "subjectYaw", 0, 0);
                String viewAngle = oneOf(value, "viewAngle", Set.of("front", "side", "rear"));
                double cameraDistance = decimal(value, "cameraDistance", 0, 12);
                boolean chestArmor = bool(value, "chestArmor");
                if ((framing.equals("first_person") && !subject.equals("player"))
                        || (!pose.equals("idle") && !subject.equals("player"))) {
                    throw new ProtocolException("Headwear fixture subject/framing/pose combination is unsupported.");
                }
                double expectedDistance = framing.equals("head") ? 2.25
                        : framing.equals("full_body") ? 6.0 : 0.0;
                if (Double.compare(cameraDistance, expectedDistance) != 0
                        || (framing.equals("first_person") && !viewAngle.equals("front"))) {
                    throw new ProtocolException(
                            "Headwear framing, view angle, and camera distance disagree.");
                }
                if (chestArmor
                        && (!subject.equals("player")
                                || !framing.equals("full_body")
                                || !pose.equals("idle")
                                || !viewAngle.equals("front")
                                || representation.review().chestArmorItemStack() == null)) {
                    throw new ProtocolException(
                            "Headwear chest-armor compatibility requires its exact declared full-body player fixture.");
                }
                return new Fixture(kind, null, stateId, null, null, 0, null, null, pose, subject, framing,
                        null, null, viewAngle, false, false, 0, 0, subjectYaw, cameraDistance,
                        chestArmor, null, null);
            }
            case ENTITY -> {
                boolean display = representation.strategy() == RepresentationStrategy.DISPLAY_RIG;
                Set<String> keys = new HashSet<>(Set.of(
                        "kind", "stateId", "pose", "angle", "showPlayerScale", "animationTick"));
                if (display) keys.add("targetKind");
                exactKeys(value, "entity fixture", keys);
                if (display && !string(value, "targetKind", 1, 16).equals("entity")) {
                    throw new ProtocolException("Display fixture targetKind must be entity.");
                }
                String pose = oneOf(value, "pose", Set.of("idle", "walk", "attack"));
                int angle = integer(value, "angle", 0, 315);
                if (angle % 45 != 0) throw new ProtocolException("Entity angle must use 45-degree increments.");
                int animationTick = integer(value, "animationTick", 0, 1_200);
                if (!display
                        && pose.equals("attack")
                        && (state.entity() == null
                                || !state.entity().entityType().equals("minecraft:zombie"))) {
                    throw new ProtocolException(
                            "Protocol v3 native attack capture is supported only for the canonical zombie fixture.");
                }
                validateAnimationTick(state, representation, pose, animationTick);
                return new Fixture(kind, display ? "entity" : null, stateId, null, null, 0, null, null,
                        pose, null, null, null, null, null, bool(value, "showPlayerScale"), false,
                        angle, animationTick, 0, 0, false, null, null);
            }
            case PLACEABLE -> {
                boolean display = representation.strategy() == RepresentationStrategy.DISPLAY_RIG;
                Set<String> keys = new HashSet<>(Set.of(
                        "kind", "stateId", "orientation", "attachment", "distance", "occluded",
                        "animationTick", "context", "subjectPosition"));
                if (display) keys.add("targetKind");
                exactKeys(value, "placeable fixture", keys);
                if (display && !string(value, "targetKind", 1, 16).equals("placeable")) {
                    throw new ProtocolException("Display fixture targetKind must be placeable.");
                }
                String orientation = oneOf(value, "orientation", Set.of("north", "east", "south", "west"));
                String attachment = oneOf(value, "attachment", Set.of("floor", "wall", "ceiling"));
                String distance = oneOf(value, "distance", Set.of("close", "player_eye", "near", "mid"));
                String context = oneOf(
                        value, "context", Set.of("plain", "corner", "doorway", "occlusion"));
                int animationTick = integer(value, "animationTick", 0, 1_200);
                validateAnimationTick(state, representation, "idle", animationTick);
                validatePlaceableBinding(stateId, state, representation, orientation, attachment);
                boolean occluded = bool(value, "occluded");
                BlockPosition subjectPosition = parseBlockPosition(
                        object(value, "subjectPosition"));
                BlockPosition expectedPosition = switch (attachment) {
                    case "floor" -> new BlockPosition(0, 80, 5);
                    case "wall" -> new BlockPosition(0, 82, 5);
                    case "ceiling" -> new BlockPosition(0, 83, 5);
                    default -> throw new IllegalStateException();
                };
                if (!subjectPosition.equals(expectedPosition)) {
                    throw new ProtocolException(
                            "Placeable subject position does not match its canonical attachment origin.");
                }
                if (representation.strategy() != RepresentationStrategy.DISPLAY_RIG
                        && !attachment.equals("floor")) {
                    throw new ProtocolException(
                            "Native placeable strategies support floor attachment only in protocol v3.");
                }
                if (occluded != context.equals("occlusion")) {
                    throw new ProtocolException(
                            "Placeable occlusion flag and strict context declaration disagree.");
                }
                return new Fixture(kind, display ? "placeable" : null, stateId, null, null, 0, orientation,
                        attachment, null, null, null, distance, context, null, false, occluded,
                        0, animationTick, 0, 0, false, subjectPosition, null);
            }
        }
        throw new ProtocolException("Scene fixture target is unsupported.");
    }

    private static void validateAnimationTick(
            RepresentationState state,
            Representation representation,
            String pose,
            int animationTick)
            throws ProtocolException {
        if (!representation.usesDisplayEntities()) {
            if (representation.targetKind() == TargetKind.ENTITY) {
                int maximum = pose.equals("attack") ? 5 : pose.equals("walk") ? 20 : 0;
                int minimum = pose.equals("idle") ? 0 : 2;
                if (animationTick < minimum || animationTick > maximum) {
                    throw new ProtocolException(
                            "Native entity animation tick is outside the supported fixed pose window.");
                }
            } else if (animationTick != 0) {
                throw new ProtocolException("Native placeables cannot declare interpolation ticks.");
            }
            return;
        }
        if (animationTick != 0) {
            throw new ProtocolException(
                    "Protocol v3 cannot drive an exact display interpolation phase; sampled interpolation scenes are unsupported.");
        }
    }

    private static void validatePlaceableBinding(
            String stateId,
            RepresentationState state,
            Representation representation,
            String orientation,
            String attachment)
            throws ProtocolException {
        String expectedStateId = representation.review().placementStates().stream()
                .filter(entry -> entry.orientation().equals(orientation)
                        && entry.attachment().equals(attachment))
                .map(PlacementState::stateId)
                .findFirst()
                .orElse(null);
        if (expectedStateId == null) {
            throw new ProtocolException(
                    "Placeable fixture has no declared placement-state binding for "
                            + orientation + "/" + attachment + ".");
        }
        if (!expectedStateId.equals(stateId)) {
            throw new ProtocolException(
                    "Placeable fixture state '" + stateId + "' does not match "
                            + orientation + "/" + attachment + "; expected state '"
                            + expectedStateId + "'.");
        }
        if (representation.strategy() == RepresentationStrategy.NATIVE_PLACEABLE_BLOCK) {
            BlockStateSpec blockState = state.blockState();
            String facing = blockState.properties().get("facing");
            if (!orientation.equals(facing)) {
                throw new ProtocolException(
                        "Native placeable blocks require an exact facing property for every orientation.");
            }
            String face = blockState.properties().get("face");
            if (face != null && !face.equals(attachment)) {
                throw new ProtocolException(
                        "Placeable attachment contradicts its exact block-state face.");
            }
        }
    }

    private static BlockPosition parseBlockPosition(JsonObject value) throws ProtocolException {
        exactKeys(value, "blockPosition", Set.of("x", "y", "z"));
        return new BlockPosition(
                integer(value, "x", -32, 32),
                integer(value, "y", 64, 96),
                integer(value, "z", -32, 32));
    }

    private static void validateReviewSelection(
            Representation representation,
            Fixture fixture,
            Environment environment,
            int fov)
            throws ProtocolException {
        Review review = representation.review();
        if (review == null) return;
        switch (representation.targetKind()) {
            case BLOCK -> {
                if (fixture.layout().equals("inventory") && review.inventoryItemStack() == null) {
                    throw new ProtocolException("Block inventory fixture has no declared item form.");
                }
                if (fixture.layout().startsWith("transparency_") && !review.transparency()) {
                    throw new ProtocolException("Block transparency fixture was not declared by review metadata.");
                }
                if (!environment.biome().equals("minecraft:plains")
                        && !review.biomeTintBiomes().contains(environment.biome())) {
                    throw new ProtocolException("Block fixture selects an undeclared biome-tint state.");
                }
                if (fixture.animationTick() != 0
                        && !review.animatedTextureTicks().contains(fixture.animationTick())) {
                    throw new ProtocolException("Block fixture selects an undeclared animated-texture tick.");
                }
            }
            case HEADWEAR -> {
                String expectedPose = review.statePoses().get(fixture.stateId());
                if (!fixture.pose().equals(expectedPose)) {
                    throw new ProtocolException("Headwear fixture pose contradicts its declared state pose.");
                }
                if (fixture.subject().equals("armor_stand") && !review.armorStand()) {
                    throw new ProtocolException("Headwear armor-stand fixture was not declared.");
                }
                if (fov > 70 && !review.wideFov()) {
                    throw new ProtocolException("Headwear wide-FOV fixture was not declared.");
                }
            }
            case ENTITY -> {
                if (environment.lightProfile().equals("low") && !review.lowLight()) {
                    throw new ProtocolException("Entity low-light fixture was not declared.");
                }
                if (fixture.animationTick() != 0
                        && !review.animationTicks().contains(fixture.animationTick())) {
                    throw new ProtocolException("Entity fixture selects an undeclared animation tick.");
                }
                if (representation.strategy() == RepresentationStrategy.DISPLAY_RIG) {
                    boolean declaredPoseState = review.poseStates().containsValue(fixture.stateId());
                    boolean exactPoseState = fixture.stateId().equals(
                            review.poseStates().get(fixture.pose()));
                    if ((declaredPoseState && !exactPoseState)
                            || (!declaredPoseState && !fixture.pose().equals("idle"))) {
                        throw new ProtocolException(
                                "Simulated entity fixture pose does not select its exact declared rig state; non-pose variants are idle-only.");
                    }
                }
            }
            case PLACEABLE -> {
                if (!review.orientations().contains(fixture.orientation())
                        || !review.attachments().contains(fixture.attachment())) {
                    throw new ProtocolException(
                            "Placeable fixture selects an undeclared orientation or attachment.");
                }
            }
            default -> { }
        }
    }

    private static void validateTargetContext(
            TargetKind targetKind, Context context, Fixture fixture) throws ProtocolException {
        switch (targetKind) {
            case HELD_ITEM -> {
                if (context != Context.WORLD && context != Context.ITEM_INSPECTION) {
                    throw new ProtocolException("Held-item scenes use only world or item-inspection contexts.");
                }
            }
            case GUI_ITEM -> {
                if (context == Context.WORLD) {
                    throw new ProtocolException("GUI-item scenes cannot use a world context.");
                }
            }
            case BLOCK -> {
                boolean inventory = fixture.layout().equals("inventory");
                if ((inventory && context != Context.INVENTORY)
                        || (!inventory && context != Context.WORLD)) {
                    throw new ProtocolException(
                            "Block inventory fixtures require inventory context; all other block fixtures require world context.");
                }
            }
            case HEADWEAR, ENTITY, PLACEABLE -> {
                if (context != Context.WORLD) {
                    throw new ProtocolException("Headwear/entity/placeable fixtures require world context.");
                }
            }
        }
    }

    private static boolean cameraFacesSubject(CameraPose camera, BlockPosition subject) {
        double dx = subject.x() + 0.5 - camera.x();
        double dy = subject.y() + 1.0 - camera.y();
        double dz = subject.z() + 0.5 - camera.z();
        double length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length < 0.25) return false;
        double yaw = Math.toRadians(camera.yaw());
        double pitch = Math.toRadians(camera.pitch());
        double cosine = Math.cos(pitch);
        double lookX = -Math.sin(yaw) * cosine;
        double lookY = -Math.sin(pitch);
        double lookZ = Math.cos(yaw) * cosine;
        return (lookX * dx + lookY * dy + lookZ * dz) / length >= 0.5;
    }

    private static Map<String, Object> parsePresentation(JsonObject value) throws ProtocolException {
        Set<String> allowed = Set.of(
                "stackCount", "selectedHotbar", "showGlint", "durabilityFraction",
                "referenceArm", "referenceArmPurpose");
        if (!allowed.containsAll(value.keySet())) {
            throw new ProtocolException("presentation contains an unknown field.");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        if (value.has("stackCount")) {
            result.put("stackCount", integer(value, "stackCount", 1, 99));
        }
        if (value.has("selectedHotbar")) {
            result.put("selectedHotbar", bool(value, "selectedHotbar"));
        }
        if (value.has("showGlint")) result.put("showGlint", bool(value, "showGlint"));
        if (value.has("referenceArm")) {
            result.put("referenceArm", bool(value, "referenceArm"));
        }
        if (value.has("referenceArmPurpose")) {
            String purpose = string(value, "referenceArmPurpose", 1, 32);
            if (!purpose.equals("scale_only")) {
                throw new ProtocolException("referenceArmPurpose must be scale_only.");
            }
            result.put("referenceArmPurpose", purpose);
        }
        if (value.has("durabilityFraction")) {
            result.put("durabilityFraction", decimal(value, "durabilityFraction", 0, 1));
        }
        return Map.copyOf(result);
    }

    private static Execution parseExecution(JsonObject value) throws ProtocolException {
        exactKeys(value, "execution", Set.of("executionId", "gameDirectory", "outputDirectory"));
        String executionId = string(value, "executionId", 1, 128);
        if (!EXECUTION_ID.matcher(executionId).matches()) {
            throw new ProtocolException("executionId contains unsafe characters.");
        }
        String game = hostPath(value, "gameDirectory");
        String output = hostPath(value, "outputDirectory");
        Path gamePath = Path.of(game);
        Path outputPath = Path.of(output);
        if (outputPath.equals(gamePath) || !outputPath.startsWith(gamePath)) {
            throw new ProtocolException("Capture output must be below the disposable game directory.");
        }
        return new Execution(executionId, game, output);
    }

    private static String hostPath(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 1, 4096);
        if (result.indexOf('\0') >= 0 || result.indexOf('\n') >= 0 || result.indexOf('\r') >= 0) {
            throw new ProtocolException(name + " contains an unsafe character.");
        }
        try {
            Path path = Path.of(result);
            if (!path.isAbsolute() || !path.normalize().equals(path) || path.getParent() == null) {
                throw new ProtocolException(name + " must be a canonical absolute host path.");
            }
        } catch (RuntimeException error) {
            throw new ProtocolException(name + " is not a valid host path.", error);
        }
        return result;
    }

    private static int utf8Length(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private static String safeId(JsonObject value, String name) throws ProtocolException {
        return safeId(string(value, name, 1, 64), name);
    }

    private static String safeId(String result, String name) throws ProtocolException {
        if (!SAFE_ID.matcher(result).matches()) {
            throw new ProtocolException(name + " contains unsafe characters.");
        }
        return result;
    }

    private static String oneOf(JsonObject value, String name, Set<String> allowed)
            throws ProtocolException {
        String result = string(value, name, 1, 64);
        if (!allowed.contains(result)) throw new ProtocolException(name + " has an unsupported value.");
        return result;
    }

    private static BlockStateSpec blockState(JsonObject value, String name)
            throws ProtocolException {
        JsonObject state = object(value, name);
        exactKeys(state, name, Set.of("id", "properties"));
        String id = resourceId(state, "id");
        JsonObject propertyObject = object(state, "properties");
        Map<String, String> properties = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : propertyObject.entrySet()) {
            if (!PROPERTY_NAME.matcher(entry.getKey()).matches()) {
                throw new ProtocolException(name + " contains an invalid property name.");
            }
            if (!entry.getValue().isJsonPrimitive()
                    || !entry.getValue().getAsJsonPrimitive().isString()) {
                throw new ProtocolException(name + " property values must be strings.");
            }
            String property = entry.getValue().getAsString();
            if (!PROPERTY_VALUE.matcher(property).matches()) {
                throw new ProtocolException(name + " contains an unsafe property value.");
            }
            properties.put(entry.getKey(), property);
        }
        return new BlockStateSpec(id, Map.copyOf(properties));
    }

    private static Vec3 vector(
            JsonArray values,
            String name,
            double minimum,
            double maximum,
            boolean strictlyPositive)
            throws ProtocolException {
        if (values.size() != 3) throw new ProtocolException(name + " must contain three numbers.");
        double[] result = new double[3];
        for (int index = 0; index < result.length; index++) {
            JsonElement element = values.get(index);
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
                throw new ProtocolException(name + " must contain only numbers.");
            }
            try {
                result[index] = element.getAsBigDecimal().doubleValue();
            } catch (NumberFormatException error) {
                throw new ProtocolException(name + " contains an invalid number.", error);
            }
            if (!Double.isFinite(result[index])
                    || result[index] < minimum
                    || result[index] > maximum
                    || (strictlyPositive && result[index] <= 0)) {
                throw new ProtocolException(name + " contains an out-of-range number.");
            }
        }
        return new Vec3(result[0], result[1], result[2]);
    }

    private static List<MeasurementIntent> parseMeasurementIntents(JsonArray values)
            throws ProtocolException {
        if (values.size() > MEASUREMENT_METRICS.size()) {
            throw new ProtocolException("measurementIntents exceeds its item budget.");
        }
        List<MeasurementIntent> result = new ArrayList<>();
        String previous = null;
        for (JsonElement element : values) {
            if (!element.isJsonObject()) {
                throw new ProtocolException("measurementIntents must contain objects.");
            }
            JsonObject value = element.getAsJsonObject();
            Set<String> required = Set.of(
                    "id", "metric", "authority", "unit", "requiredForReadiness");
            Set<String> allowed = Set.of(
                    "id", "metric", "authority", "unit", "requiredForReadiness", "threshold", "sourceSceneIds");
            if (!value.keySet().containsAll(required) || !allowed.containsAll(value.keySet())) {
                throw fieldMismatch("measurement intent", value.keySet(), required, allowed);
            }
            String id = safeId(value, "id");
            if (previous != null && previous.compareTo(id) >= 0) {
                throw new ProtocolException("measurementIntents must be uniquely sorted by id.");
            }
            String metric = oneOf(value, "metric", MEASUREMENT_METRICS);
            String authority = string(value, "authority", 1, 32);
            if (!authority.equals("client_pixels")) {
                throw new ProtocolException("Measurement intent authority must be client_pixels.");
            }
            String unit = oneOf(value, "unit", MEASUREMENT_UNITS);
            boolean requiredForReadiness = bool(value, "requiredForReadiness");
            MeasurementThreshold threshold = null;
            if (value.has("threshold")) {
                JsonObject thresholdValue = object(value, "threshold");
                exactKeys(thresholdValue, "measurement threshold", Set.of(
                        "comparison", "warning", "failure"));
                String comparison = oneOf(
                        thresholdValue, "comparison", Set.of("above", "below"));
                double warning = decimal(thresholdValue, "warning", -1_000_000, 1_000_000);
                double failure = decimal(thresholdValue, "failure", -1_000_000, 1_000_000);
                if ((comparison.equals("above") && warning > failure)
                        || (comparison.equals("below") && warning < failure)) {
                    throw new ProtocolException(
                            "Measurement warning/failure thresholds are ordered incorrectly.");
                }
                threshold = new MeasurementThreshold(comparison, warning, failure);
            }
            List<String> sourceSceneIds = value.has("sourceSceneIds")
                    ? parseSafeIdList(array(value, "sourceSceneIds"), "sourceSceneIds", 16)
                    : null;
            result.add(new MeasurementIntent(
                    id, metric, authority, unit, requiredForReadiness, threshold, sourceSceneIds));
            previous = id;
        }
        return List.copyOf(result);
    }

    private static List<String> parseSafeIdList(JsonArray values, String name, int maximum)
            throws ProtocolException {
        if (values.size() > maximum) throw new ProtocolException(name + " exceeds its item budget.");
        List<String> result = new ArrayList<>();
        String previous = null;
        for (JsonElement element : values) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw new ProtocolException(name + " must contain strings.");
            }
            String item = safeId(element.getAsString(), name);
            if (previous != null && previous.compareTo(item) >= 0) {
                throw new ProtocolException(name + " must be uniquely sorted.");
            }
            result.add(item);
            previous = item;
        }
        return List.copyOf(result);
    }

    private static List<String> parseResourceIdList(
            JsonArray values, String name, int maximum) throws ProtocolException {
        if (values.size() > maximum) throw new ProtocolException(name + " exceeds its item budget.");
        List<String> result = new ArrayList<>();
        String previous = null;
        for (JsonElement element : values) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw new ProtocolException(name + " must contain resource-id strings.");
            }
            String item = element.getAsString();
            if (!RESOURCE_ID.matcher(item).matches()) {
                throw new ProtocolException(name + " contains an invalid resource id.");
            }
            if (previous != null && previous.compareTo(item) >= 0) {
                throw new ProtocolException(name + " must be uniquely sorted.");
            }
            result.add(item);
            previous = item;
        }
        return List.copyOf(result);
    }

    private static List<Integer> parseIntegerList(
            JsonArray values,
            String name,
            int maximumItems,
            int minimum,
            int maximum)
            throws ProtocolException {
        if (values.size() > maximumItems) {
            throw new ProtocolException(name + " exceeds its item budget.");
        }
        List<Integer> result = new ArrayList<>();
        Integer previous = null;
        for (JsonElement element : values) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
                throw new ProtocolException(name + " must contain integers.");
            }
            final int item;
            try {
                item = element.getAsBigDecimal().intValueExact();
            } catch (ArithmeticException | NumberFormatException error) {
                throw new ProtocolException(name + " must contain integers.", error);
            }
            if (item < minimum || item > maximum) {
                throw new ProtocolException(name + " contains an out-of-range integer.");
            }
            if (previous != null && previous >= item) {
                throw new ProtocolException(name + " must be uniquely sorted.");
            }
            result.add(item);
            previous = item;
        }
        return List.copyOf(result);
    }

    private static List<String> parseCanonicalStringList(
            JsonArray values, String name, List<String> canonicalOrder) throws ProtocolException {
        if (values.size() > canonicalOrder.size()) {
            throw new ProtocolException(name + " exceeds its item budget.");
        }
        List<String> result = new ArrayList<>();
        int previousIndex = -1;
        for (JsonElement element : values) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw new ProtocolException(name + " must contain strings.");
            }
            String item = element.getAsString();
            int index = canonicalOrder.indexOf(item);
            if (index < 0) throw new ProtocolException(name + " contains an unsupported value.");
            if (index <= previousIndex) {
                throw new ProtocolException(name + " must use canonical target-profile order.");
            }
            result.add(item);
            previousIndex = index;
        }
        return List.copyOf(result);
    }

    private static String resourceId(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 3, 512);
        if (!RESOURCE_ID.matcher(result).matches()) {
            throw new ProtocolException(name + " must be a namespaced resource id.");
        }
        return result;
    }

    private static String sha1(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 40, 40);
        if (!SHA1.matcher(result).matches()) throw new ProtocolException(name + " must be lowercase SHA-1.");
        return result;
    }

    private static String sha256(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 64, 64);
        if (!SHA256.matcher(result).matches()) {
            throw new ProtocolException(name + " must be lowercase SHA-256.");
        }
        return result;
    }

    private static JsonObject object(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonObject()) throw new ProtocolException(name + " must be an object.");
        return value.getAsJsonObject();
    }

    private static JsonArray array(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonArray()) throw new ProtocolException(name + " must be an array.");
        return value.getAsJsonArray();
    }

    private static String string(JsonObject parent, String name, int minimum, int maximum)
            throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new ProtocolException(name + " must be a string.");
        }
        String result = value.getAsString();
        if (result.length() < minimum || result.length() > maximum) {
            throw new ProtocolException(name + " has an invalid length.");
        }
        return result;
    }

    private static boolean bool(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
            throw new ProtocolException(name + " must be a boolean.");
        }
        return value.getAsBoolean();
    }

    private static int integer(JsonObject parent, String name, int minimum, int maximum)
            throws ProtocolException {
        BigDecimal number = number(parent, name);
        final int result;
        try {
            result = number.intValueExact();
        } catch (ArithmeticException error) {
            throw new ProtocolException(name + " must be an integer.", error);
        }
        if (result < minimum || result > maximum) throw new ProtocolException(name + " is out of range.");
        return result;
    }

    private static double decimal(JsonObject parent, String name, double minimum, double maximum)
            throws ProtocolException {
        double result = number(parent, name).doubleValue();
        if (!Double.isFinite(result) || result < minimum || result > maximum) {
            throw new ProtocolException(name + " is out of range.");
        }
        return result;
    }

    private static BigDecimal number(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException(name + " must be a number.");
        }
        try {
            return value.getAsBigDecimal();
        } catch (NumberFormatException error) {
            throw new ProtocolException(name + " must be a finite JSON number.", error);
        }
    }

    private static <E extends Enum<E>> E enumValue(JsonObject parent, String name, Class<E> type)
            throws ProtocolException {
        String value = string(parent, name, 1, 64).toUpperCase(Locale.ROOT);
        try {
            return Enum.valueOf(type, value);
        } catch (IllegalArgumentException error) {
            throw new ProtocolException(name + " has an unsupported value.", error);
        }
    }

    private static void exactKeys(JsonObject object, String label, Set<String> expected)
            throws ProtocolException {
        if (!object.keySet().equals(expected)) {
            throw fieldMismatch(label, object.keySet(), expected, expected);
        }
    }

    private static ProtocolException fieldMismatch(
            String label, Set<String> actual, Set<String> required, Set<String> allowed) {
        Set<String> missing = new HashSet<>(required);
        missing.removeAll(actual);
        Set<String> unknown = new HashSet<>(actual);
        unknown.removeAll(allowed);
        return new ProtocolException(
                label + " fields mismatch; missing=" + missing + ", unknown=" + unknown + '.');
    }
}
