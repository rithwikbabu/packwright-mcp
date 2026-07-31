package io.github.rithwikbabu.packwright.capture;

import io.github.rithwikbabu.packwright.capture.mixin.BlockDisplayAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.DisplayAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.InteractionAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.ItemDisplayAccessor;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.BlockStateSpec;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.DisplayNode;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.DisplayRig;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.EntitySpec;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Fixture;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.ItemStackSpec;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Representation;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.RepresentationState;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Scene;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Studio;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Vec3;
import io.github.rithwikbabu.packwright.capture.SceneFixtureExecutor.EntityHandle;
import io.github.rithwikbabu.packwright.capture.SceneFixtureExecutor.FixtureEvidence;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.state.ArmedEntityRenderState;
import net.minecraft.client.renderer.entity.state.BlockDisplayEntityRenderState;
import net.minecraft.client.renderer.entity.state.DisplayEntityRenderState;
import net.minecraft.client.renderer.entity.state.ItemDisplayEntityRenderState;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.Registry;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Interaction;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.util.Brightness;
import net.minecraft.util.Mth;

/**
 * Reads the exact fixture back from the client world and the client renderer.
 * The canonical map is emitted only after every observed value matches the
 * hash-bound representation. It is therefore not a plan echo.
 */
final class ClientFixtureObserver {
    private ClientFixtureObserver() {}

    static Map<String, Object> observe(
            Minecraft client,
            Scene scene,
            Scene authoritativeBase,
            Representation representation,
            Studio studio,
            FixtureEvidence evidence) {
        if (client.level == null || client.player == null) {
            throw new ObservationPendingException("Client world is not available for fixture readback.");
        }
        if (scene.fixture().kind().equals("measurement_control")) {
            verifyMeasurementControl(client, authoritativeBase, studio, evidence);
            return expectedObservedFixture(scene, representation);
        }
        RepresentationState state = representation.state(scene.fixture().stateId());
        if (state == null) throw new IllegalStateException("Observed fixture state disappeared.");
        switch (representation.strategy()) {
            case ITEM_STACK -> verifyItem(client, scene, state);
            case NATIVE_BLOCK_STATE -> verifyNativeBlock(client, scene, state, representation);
            case BLOCK_DISPLAY -> verifyBlockDisplay(client, scene, state, evidence, representation);
            case EQUIPPABLE_HEAD -> verifyHeadwear(client, scene, state, evidence, representation);
            case NATIVE_ENTITY -> verifyNativeEntity(client, scene, state.entity(), evidence, true);
            case NATIVE_PLACEABLE_BLOCK -> verifyNativePlaceableBlock(client, scene, state);
            case NATIVE_PLACEABLE_ENTITY ->
                    verifyNativeEntity(client, scene, state.entity(), evidence, false);
            case DISPLAY_RIG -> verifyDisplayRig(client, scene, state.displayRig(), evidence);
        }
        if (scene.targetKind() == CapturePlan.TargetKind.PLACEABLE) {
            verifyPlaceableContext(
                    client,
                    scene.fixture(),
                    SceneFixtureExecutor.subjectPosition(scene),
                    studio);
        }
        return expectedObservedFixture(scene, representation);
    }

    static Map<String, Object> observeStudioScaleReference(
            Minecraft client, Studio studio) {
        if (client.level == null) {
            throw new ObservationPendingException(
                    "Client world is unavailable for studio scale-reference readback.");
        }
        CapturePlan.StudioScaleReference reference = studio.scaleReference();
        List<BlockPos> positions = CaptureCoordinator.scaleReferencePositions(reference);
        BlockState expectedFirst = parseClientBlockState(client, reference.firstBlock());
        BlockState expectedSecond = parseClientBlockState(client, reference.secondBlock());
        requireExactBlock(client, positions.get(0), expectedFirst, true);
        requireExactBlock(client, positions.get(1), expectedSecond, true);

        BlockState actualFirst = client.level.getBlockState(positions.get(0));
        BlockState actualSecond = client.level.getBlockState(positions.get(1));
        CapturePlan.StudioScaleReference observed = new CapturePlan.StudioScaleReference(
                reference.kind(),
                reference.origin(),
                positions.size(),
                new BlockStateSpec(
                        BuiltInRegistries.BLOCK.getKey(actualFirst.getBlock()).toString(),
                        Map.of()),
                new BlockStateSpec(
                        BuiltInRegistries.BLOCK.getKey(actualSecond.getBlock()).toString(),
                        Map.of()));
        return observed.toProtocolValue();
    }

    private static void verifyItem(Minecraft client, Scene scene, RepresentationState state) {
        ItemStack expected = SceneFixtureExecutor.parseItem(
                state.itemStack(), client.level.registryAccess());
        if (scene.context() == CapturePlan.Context.WORLD) {
            ItemStack actual = scene.hand() == CapturePlan.Hand.RIGHT
                    ? client.player.getMainHandItem()
                    : client.player.getOffhandItem();
            requireExactStack(actual, expected, "client-rendered item stack");
        }
    }

    private static void verifyNativeBlock(
            Minecraft client,
            Scene scene,
            RepresentationState state,
            Representation representation) {
        if (scene.fixture().layout().equals("inventory")) {
            ItemStack expected = SceneFixtureExecutor.parseItem(
                    representation.review().inventoryItemStack(), client.level.registryAccess());
            requireExactStack(
                    client.player.getInventory().getItem(0), expected, "block inventory item");
            return;
        }
        BlockPos origin = SceneFixtureExecutor.subjectPosition(scene);
        BlockState expected = parseClientBlockState(client, state.blockState());
        requireExactBlock(client, origin, expected, true);
        verifyBlockLayout(client, scene.fixture(), origin, expected, false);
    }

    private static void verifyBlockDisplay(
            Minecraft client,
            Scene scene,
            RepresentationState state,
            FixtureEvidence evidence,
            Representation representation) {
        if (scene.fixture().layout().equals("inventory")) {
            ItemStack expected = SceneFixtureExecutor.parseItem(
                    representation.review().inventoryItemStack(), client.level.registryAccess());
            requireExactStack(
                    client.player.getInventory().getItem(0), expected, "block-display inventory item");
            if (!evidence.entityHandles().isEmpty()) {
                throw new IllegalStateException("Inventory block capture unexpectedly spawned a display.");
            }
            return;
        }
        List<BlockPos> origins = blockDisplayOrigins(
                SceneFixtureExecutor.subjectPosition(scene), scene.fixture().layout());
        if (evidence.entityHandles().size() != origins.size()) {
            throw new IllegalStateException("Block-display client handle count disagrees with its layout.");
        }
        for (int index = 0; index < origins.size(); index++) {
            Entity entity = exactClientEntity(client, evidence.entityHandles().get(index));
            verifyDisplayNode(client, entity, state.blockDisplay(), 0.0F, origins.get(index));
        }
        verifyBlockLayout(
                client,
                scene.fixture(),
                SceneFixtureExecutor.subjectPosition(scene),
                null,
                true);
    }

    private static void verifyNativePlaceableBlock(
            Minecraft client, Scene scene, RepresentationState state) {
        BlockPos origin = SceneFixtureExecutor.subjectPosition(scene);
        BlockState expected = parseClientBlockState(client, state.blockState());
        requireExactBlock(client, origin, expected, true);
    }

    private static void verifyHeadwear(
            Minecraft client,
            Scene scene,
            RepresentationState state,
            FixtureEvidence evidence,
            Representation representation) {
        Fixture fixture = scene.fixture();
        ItemStack expectedHead = SceneFixtureExecutor.parseItem(
                state.itemStack(), client.level.registryAccess());
        ItemStack expectedChest = fixture.chestArmor()
                ? SceneFixtureExecutor.parseItem(
                        representation.review().chestArmorItemStack(), client.level.registryAccess())
                : ItemStack.EMPTY;
        Entity subject;
        if (fixture.subject().equals("armor_stand")) {
            if (evidence.entityHandles().size() != 1) {
                throw new IllegalStateException("Armor-stand fixture has no exact client handle.");
            }
            subject = exactClientEntity(client, evidence.entityHandles().getFirst());
            if (!(subject instanceof ArmorStand stand)) {
                throw new IllegalStateException("Headwear fixture handle is not an armor stand.");
            }
            requireExactStack(
                    stand.getItemBySlot(EquipmentSlot.HEAD), expectedHead, "armor-stand head item");
            BlockPos origin = SceneFixtureExecutor.SUBJECT_ORIGIN;
            requireNear(stand.getX(), origin.getX() + 0.5, "armor-stand x");
            requireNear(stand.getY(), origin.getY(), "armor-stand y");
            requireNear(stand.getZ(), origin.getZ() + 0.5, "armor-stand z");
            if (angleDifference(stand.getYRot(), quantizedDegrees(fixture.subjectYaw()))
                    > 0.0001F) {
                throw new IllegalStateException(
                        "Armor-stand headwear yaw differs from capture provenance.");
            }
        } else {
            subject = client.player;
            ItemStack actualHead = client.player.getItemBySlot(EquipmentSlot.HEAD);
            if (fixture.subject().equals("bare_control")) {
                if (!actualHead.isEmpty()) {
                    throw new IllegalStateException("Bare-head control retained a head item.");
                }
            } else {
                requireExactStack(actualHead, expectedHead, "equipped player head item");
            }
            requireExactStack(
                    client.player.getItemBySlot(EquipmentSlot.CHEST),
                    expectedChest,
                    "headwear compatibility chest item");
        }
        var renderState = client.getEntityRenderDispatcher().extractEntity(subject, 1.0F);
        if (!(renderState instanceof LivingEntityRenderState livingState)
                || livingState.pose != subject.getPose()) {
            throw new ObservationPendingException(
                    "Headwear subject has not reached a renderer-consumed body pose.");
        }
    }

    private static void verifyNativeEntity(
            Minecraft client,
            Scene scene,
            EntitySpec expected,
            FixtureEvidence evidence,
            boolean animatedProfile) {
        int expectedHandles = 1 + (animatedProfile && scene.fixture().showPlayerScale() ? 1 : 0);
        if (evidence.entityHandles().size() != expectedHandles) {
            throw new IllegalStateException("Native entity fixture handle count is incomplete.");
        }
        Entity entity = exactClientEntity(client, evidence.entityHandles().getFirst());
        if (!EntityType.getKey(entity.getType()).toString().equals(expected.entityType())) {
            throw new IllegalStateException("Client entity type differs from capture provenance.");
        }
        verifyEntityPositionAndYaw(entity, scene);
        if (!(entity instanceof LivingEntity living)) {
            throw new IllegalStateException("Allow-listed native entity is not renderer-living.");
        }
        if (living.isBaby() != expected.baby()) {
            throw new IllegalStateException("Client entity age differs from capture provenance.");
        }
        verifyVariant(entity, expected);
        for (Map.Entry<String, ItemStackSpec> entry : expected.equipment().entrySet()) {
            ItemStack planned = SceneFixtureExecutor.parseItem(
                    entry.getValue(), client.level.registryAccess());
            requireExactStack(
                    living.getItemBySlot(equipmentSlot(entry.getKey())),
                    planned,
                    "native entity equipment " + entry.getKey());
        }
        if (animatedProfile) applyDeterministicEntityPose(living, scene.fixture());
        var renderState = client.getEntityRenderDispatcher().extractEntity(entity, 1.0F);
        if (!(renderState instanceof LivingEntityRenderState livingState)
                || livingState.isBaby != expected.baby()
                || livingState.pose != living.getPose()) {
            throw new ObservationPendingException(
                    "Native entity has not reached its renderer-consumed age/pose state.");
        }
        if (animatedProfile && scene.fixture().pose().equals("walk")
                && livingState.walkAnimationSpeed <= 0.0F) {
            throw new ObservationPendingException(
                    "Native walk fixture has not reached a renderer-consumed walk state.");
        }
        if (animatedProfile && scene.fixture().pose().equals("attack")) {
            if (!(livingState instanceof ArmedEntityRenderState armed)
                    || armed.attackTime <= 0.0F) {
                throw new ObservationPendingException(
                        "Native attack fixture has not reached a renderer-consumed attack state.");
            }
        }
        if (animatedProfile && scene.fixture().showPlayerScale()) {
            Entity scale = exactClientEntity(client, evidence.entityHandles().get(1));
            if (!EntityType.getKey(scale.getType()).toString().equals("minecraft:mannequin")) {
                throw new IllegalStateException("Entity scale reference is not a Minecraft mannequin.");
            }
            if (client.getEntityRenderDispatcher().extractEntity(scale, 1.0F) == null) {
                throw new ObservationPendingException("Scale-reference renderer state is unavailable.");
            }
        }
    }

    private static void applyDeterministicEntityPose(LivingEntity living, Fixture fixture) {
        if (fixture.pose().equals("walk")) {
            living.walkAnimation.stop();
            for (int tick = 0; tick < fixture.animationTick(); tick++) {
                living.walkAnimation.update(1.0F, 1.0F, 1.0F);
            }
        } else if (fixture.pose().equals("attack") && living.getAttackAnim(1.0F) <= 0.0F) {
            living.swing(InteractionHand.MAIN_HAND, true);
        }
    }

    private static void verifyDisplayRig(
            Minecraft client, Scene scene, DisplayRig rig, FixtureEvidence evidence) {
        int expectedHandles = rig.nodes().size() + (rig.interaction() == null ? 0 : 1);
        boolean scale = scene.targetKind() == CapturePlan.TargetKind.ENTITY
                && scene.fixture().showPlayerScale();
        if (scale) expectedHandles++;
        if (evidence.entityHandles().size() != expectedHandles) {
            throw new IllegalStateException("Display-rig client handle count is incomplete.");
        }
        float yaw = scene.targetKind() == CapturePlan.TargetKind.ENTITY
                ? SceneFixtureExecutor.turntableYaw(scene.fixture().angle())
                : SceneFixtureExecutor.orientationYaw(scene.fixture().orientation());
        BlockPos origin = SceneFixtureExecutor.subjectPosition(scene);
        for (int index = 0; index < rig.nodes().size(); index++) {
            verifyDisplayNode(
                    client,
                    exactClientEntity(client, evidence.entityHandles().get(index)),
                    rig.nodes().get(index),
                    yaw,
                    origin);
        }
        int next = rig.nodes().size();
        if (rig.interaction() != null) {
            verifyInteraction(
                    exactClientEntity(client, evidence.entityHandles().get(next++)),
                    rig,
                    yaw,
                    origin);
        }
        if (scale) {
            Entity mannequin = exactClientEntity(client, evidence.entityHandles().get(next));
            if (!EntityType.getKey(mannequin.getType()).toString().equals("minecraft:mannequin")) {
                throw new IllegalStateException("Display-rig scale reference is not a mannequin.");
            }
        }
    }

    private static void verifyDisplayNode(
            Minecraft client,
            Entity raw,
            DisplayNode expected,
            float orientationYaw,
            BlockPos origin) {
        if (!(raw instanceof Display display)) {
            throw new IllegalStateException("Display node handle is not a display entity.");
        }
        Vec3 rotated = SceneFixtureExecutor.rotateAroundY(expected.position(), orientationYaw);
        requireNear(display.getX(), origin.getX() + 0.5 + rotated.x(), "display x");
        requireNear(display.getY(), origin.getY() + rotated.y(), "display y");
        requireNear(display.getZ(), origin.getZ() + 0.5 + rotated.z(), "display z");
        float expectedYaw = quantizedDegrees((float) expected.yaw() + orientationYaw);
        float expectedPitch = quantizedDegrees((float) expected.pitch());
        if (angleDifference(display.getYRot(), expectedYaw) > 0.0001F
                || angleDifference(display.getXRot(), expectedPitch) > 0.0001F) {
            throw new IllegalStateException("Client display rotation differs from network provenance.");
        }
        DisplayAccessor accessor = (DisplayAccessor) display;
        if (!DisplayAccessor.packwrightCapture$createTransformation(display.getEntityData())
                        .equals(SceneFixtureExecutor.transformation(expected.transform()))
                || accessor.packwrightCapture$getTransformationInterpolationDuration()
                        != expected.interpolation().duration()
                || accessor.packwrightCapture$getTransformationInterpolationDelay()
                        != expected.interpolation().startDelta()
                || !accessor.packwrightCapture$getBillboardConstraints().getSerializedName()
                        .equals(expected.billboard())
                || !accessor.packwrightCapture$getBrightnessOverride().equals(
                        new Brightness(expected.brightness().block(), expected.brightness().sky()))
                || Float.compare(accessor.packwrightCapture$getShadowRadius(),
                                (float) expected.shadow().radius())
                        != 0
                || Float.compare(accessor.packwrightCapture$getShadowStrength(),
                                (float) expected.shadow().strength())
                        != 0) {
            throw new IllegalStateException(
                    "Client display transform/render properties differ from provenance.");
        }
        if (expected.kind().equals("block_display")) {
            if (!(display instanceof Display.BlockDisplay block)) {
                throw new IllegalStateException("Expected block_display client entity.");
            }
            BlockState planned = parseClientBlockState(client, expected.blockState());
            if (!((BlockDisplayAccessor) block).packwrightCapture$getBlockState().equals(planned)) {
                throw new IllegalStateException("Client block display state differs from provenance.");
            }
        } else {
            if (!(display instanceof Display.ItemDisplay item)) {
                throw new IllegalStateException("Expected item_display client entity.");
            }
            ItemStack planned = SceneFixtureExecutor.parseItem(
                    expected.itemStack(), client.level.registryAccess());
            ItemDisplayAccessor itemAccessor = (ItemDisplayAccessor) item;
            requireExactStack(itemAccessor.packwrightCapture$getItemStack(), planned, "item display stack");
            if (itemAccessor.packwrightCapture$getItemTransform()
                    != SceneFixtureExecutor.itemDisplayContext(expected.itemDisplayContext())) {
                throw new IllegalStateException("Client item-display context differs from provenance.");
            }
        }
        var extracted = client.getEntityRenderDispatcher().extractEntity(display, 1.0F);
        if (!(extracted instanceof DisplayEntityRenderState rendered)
                || rendered.renderState == null
                || !rendered.hasSubState()) {
            throw new ObservationPendingException(
                    "Display entity has not reached a baked renderer sub-state.");
        }
        if (rendered instanceof BlockDisplayEntityRenderState blockState
                && blockState.blockModel.isEmpty()) {
            throw new ObservationPendingException("Block display renderer model is empty.");
        }
        if (rendered instanceof ItemDisplayEntityRenderState itemState
                && itemState.item.isEmpty()) {
            throw new ObservationPendingException("Item display renderer model is empty.");
        }
    }

    private static void verifyInteraction(
            Entity raw, DisplayRig rig, float orientationYaw, BlockPos origin) {
        if (!(raw instanceof Interaction interaction)) {
            throw new IllegalStateException("Interaction handle is not an interaction entity.");
        }
        Vec3 rotated = SceneFixtureExecutor.rotateAroundY(
                rig.interaction().position(), orientationYaw);
        requireNear(interaction.getX(), origin.getX() + 0.5 + rotated.x(), "interaction x");
        requireNear(interaction.getY(), origin.getY() + rotated.y(), "interaction y");
        requireNear(interaction.getZ(), origin.getZ() + 0.5 + rotated.z(), "interaction z");
        InteractionAccessor accessor = (InteractionAccessor) interaction;
        if (Float.compare(accessor.packwrightCapture$getWidth(),
                        (float) rig.interaction().width())
                        != 0
                || Float.compare(accessor.packwrightCapture$getHeight(),
                                (float) rig.interaction().height())
                        != 0
                || accessor.packwrightCapture$getResponse()) {
            throw new IllegalStateException(
                    "Client interaction dimensions/response differ from provenance.");
        }
    }

    private static void verifyMeasurementControl(
            Minecraft client, Scene base, Studio studio, FixtureEvidence evidence) {
        if (!Boolean.TRUE.equals(evidence.subjectOmitted())) {
            throw new IllegalStateException("Measurement control lacks omission evidence.");
        }
        BlockPos origin = SceneFixtureExecutor.subjectPosition(base);
        switch (base.targetKind()) {
            case BLOCK, PLACEABLE -> {
                if (!client.level.getBlockState(origin).isAir()) {
                    throw new ObservationPendingException(
                            "Empty-subject control still contains the measured block.");
                }
                if (!evidence.entityHandles().isEmpty()) {
                    throw new IllegalStateException(
                            "Empty-subject control unexpectedly retained a subject entity.");
                }
                if (base.targetKind() == CapturePlan.TargetKind.PLACEABLE) {
                    verifyPlaceableContext(client, base.fixture(), origin, studio);
                }
            }
            case HEADWEAR -> {
                if (!client.player.getItemBySlot(EquipmentSlot.HEAD).isEmpty()
                        || !client.player.getItemBySlot(EquipmentSlot.CHEST).isEmpty()) {
                    throw new ObservationPendingException(
                            "Empty headwear control still contains equipped subject assets.");
                }
            }
            case ENTITY -> {
                if (base.fixture().showPlayerScale()) {
                    if (evidence.entityHandles().size() != 1) {
                        throw new IllegalStateException(
                                "Entity control lost its ordinary mannequin scale reference.");
                    }
                    Entity mannequin = exactClientEntity(
                            client, evidence.entityHandles().getFirst());
                    if (!EntityType.getKey(mannequin.getType()).toString()
                                    .equals("minecraft:mannequin")
                            || client.getEntityRenderDispatcher().extractEntity(mannequin, 1.0F)
                                    == null) {
                        throw new ObservationPendingException(
                                "Entity control mannequin is not renderer-ready.");
                    }
                } else if (!evidence.entityHandles().isEmpty()) {
                    throw new IllegalStateException(
                            "Empty entity control unexpectedly retained a subject entity.");
                }
            }
            default -> throw new IllegalStateException(
                    "Item target escaped measurement-control validation.");
        }
    }

    private static void verifyBlockLayout(
            Minecraft client,
            Fixture fixture,
            BlockPos origin,
            BlockState repeatedSubject,
            boolean displaySubject) {
        switch (fixture.layout()) {
            case "single", "inventory" -> { }
            case "adjacency" -> {
                if (!displaySubject) {
                    requireExactBlock(client, origin.east(), repeatedSubject, true);
                    requireExactBlock(client, origin.south(), repeatedSubject, true);
                }
                requireBlock(client, origin.west(), Blocks.STONE.defaultBlockState(), "adjacency neighbor");
            }
            case "culling" -> {
                requireBlock(client, origin.east(), Blocks.STONE.defaultBlockState(), "culling east");
                requireBlock(client, origin.north(), Blocks.STONE.defaultBlockState(), "culling north");
                requireBlock(client, origin.below(), Blocks.STONE.defaultBlockState(), "culling floor");
            }
            case "transparency_light", "transparency_overlap" -> requireBlock(
                    client,
                    origin.south(2),
                    Blocks.CONCRETE.white().defaultBlockState(),
                    "light transparency backdrop");
            case "transparency_dark" -> requireBlock(
                    client,
                    origin.south(2),
                    Blocks.CONCRETE.black().defaultBlockState(),
                    "dark transparency backdrop");
            default -> throw new IllegalStateException("Unknown block layout after validation.");
        }
    }

    private static List<BlockPos> blockDisplayOrigins(BlockPos origin, String layout) {
        List<BlockPos> result = new ArrayList<>();
        result.add(origin);
        if (layout.equals("adjacency")) {
            result.add(origin.east());
            result.add(origin.south());
        } else if (layout.equals("transparency_overlap")) {
            result.add(origin.south());
        }
        return List.copyOf(result);
    }

    private static void verifyPlaceableContext(
            Minecraft client, Fixture fixture, BlockPos origin, Studio studio) {
        if (fixture.attachment().equals("floor")) {
            BlockState expectedFloor = parseClientBlockState(client, studio.floorBlock());
            requireExactBlock(client, origin.below(), expectedFloor, true);
        }
        for (BlockPos position : PlaceableStudioGeometry.requiredStoneBlocks(
                fixture.attachment(),
                fixture.orientation(),
                fixture.context(),
                fixture.occluded(),
                origin)) {
            requireBlock(
                    client,
                    position,
                    Blocks.STONE.defaultBlockState(),
                    "placeable attachment/context");
        }
        for (BlockPos position : PlaceableStudioGeometry.requiredAirBlocks(
                fixture.attachment(),
                fixture.orientation(),
                fixture.context(),
                fixture.occluded(),
                origin)) {
            requireAir(client, position, "inactive placeable attachment/context");
        }
    }

    private static void verifyEntityPositionAndYaw(Entity entity, Scene scene) {
        BlockPos origin = SceneFixtureExecutor.subjectPosition(scene);
        requireNear(entity.getX(), origin.getX() + 0.5, "native entity x");
        requireNear(entity.getY(), origin.getY(), "native entity y");
        requireNear(entity.getZ(), origin.getZ() + 0.5, "native entity z");
        float expectedYaw = scene.targetKind() == CapturePlan.TargetKind.ENTITY
                ? SceneFixtureExecutor.turntableYaw(scene.fixture().angle())
                : SceneFixtureExecutor.orientationYaw(scene.fixture().orientation());
        if (!entityYawMatches(entity.getYRot(), expectedYaw)) {
            throw new ObservationPendingException(entityYawMismatch(entity.getYRot(), expectedYaw));
        }
    }

    private static Entity exactClientEntity(Minecraft client, EntityHandle handle) {
        Entity entity = client.level.getEntity(handle.id());
        if (entity == null) {
            throw new ObservationPendingException(
                    "Client has not received a server-issued fixture entity handle.");
        }
        if (!entity.getUUID().equals(handle.uuid())) {
            throw new IllegalStateException("Client fixture entity id was reused with a stale UUID.");
        }
        return entity;
    }

    private static BlockState parseClientBlockState(Minecraft client, BlockStateSpec planned) {
        try {
            return BlockStateParser.parseForBlock(
                            client.level.registryAccess().lookupOrThrow(Registries.BLOCK),
                            planned.commandSyntax(),
                            false)
                    .blockState();
        } catch (com.mojang.brigadier.exceptions.CommandSyntaxException error) {
            throw new IllegalStateException("Client registries rejected a bound block state.", error);
        }
    }

    private static void requireExactBlock(
            Minecraft client, BlockPos position, BlockState expected, boolean requireModel) {
        BlockState actual = client.level.getBlockState(position);
        if (!actual.equals(expected)) {
            throw new ObservationPendingException(
                    "Client has not received the exact bound block state at " + position + '.');
        }
        if (requireModel) {
            var models = client.getModelManager().getBlockStateModelSet();
            if (models.get(actual) == models.missingModel()) {
                throw new IllegalStateException(
                        "Client block state resolved only to Minecraft's missing model.");
            }
        }
    }

    private static void requireBlock(
            Minecraft client, BlockPos position, BlockState expected, String label) {
        if (!client.level.getBlockState(position).equals(expected)) {
            throw new ObservationPendingException(
                    "Client has not received the exact " + label + " studio block at "
                            + position + '.');
        }
    }

    private static void requireAir(Minecraft client, BlockPos position, String label) {
        if (!client.level.getBlockState(position).equals(Blocks.AIR.defaultBlockState())) {
            throw new ObservationPendingException(
                    "Client still contains stale " + label + " geometry at " + position + '.');
        }
    }

    private static void requireExactStack(ItemStack actual, ItemStack expected, String label) {
        if (!SceneFixtureExecutor.exactStack(actual, expected)) {
            throw new ObservationPendingException(
                    "Client has not received the exact " + label + '.');
        }
    }

    private static void requireNear(double actual, double expected, String label) {
        if (Math.abs(actual - expected) > 1.0 / 4096.0) {
            throw new IllegalStateException(label + " differs from network provenance.");
        }
    }

    static float networkQuantizedYaw(float value) {
        return Mth.unpackDegrees(Mth.packDegrees(value));
    }

    static boolean entityYawMatches(float actual, float expectedRaw) {
        return angleDifference(actual, networkQuantizedYaw(expectedRaw)) <= 0.0001F;
    }

    static String entityYawMismatch(float actual, float expectedRaw) {
        return "Client native entity yaw differs from provenance: actual=" + actual
                + ", expectedRaw=" + expectedRaw
                + ", expectedNetwork=" + networkQuantizedYaw(expectedRaw) + '.';
    }

    private static float quantizedDegrees(float value) {
        return networkQuantizedYaw(value);
    }

    private static float angleDifference(float left, float right) {
        float raw = Math.abs(left - right) % 360.0F;
        return Math.min(raw, 360.0F - raw);
    }

    private static EquipmentSlot equipmentSlot(String slot) {
        return switch (slot) {
            case "head" -> EquipmentSlot.HEAD;
            case "chest" -> EquipmentSlot.CHEST;
            case "legs" -> EquipmentSlot.LEGS;
            case "feet" -> EquipmentSlot.FEET;
            case "mainhand" -> EquipmentSlot.MAINHAND;
            case "offhand" -> EquipmentSlot.OFFHAND;
            default -> throw new IllegalStateException("Unknown equipment slot after validation.");
        };
    }

    private static void verifyVariant(Entity entity, EntitySpec expected) {
        if (expected.variant() == null) return;
        switch (expected.entityType()) {
            case "minecraft:cat" -> verifyHolderVariant(
                    entity, expected.variant(), DataComponents.CAT_VARIANT);
            case "minecraft:chicken" -> verifyHolderVariant(
                    entity, expected.variant(), DataComponents.CHICKEN_VARIANT);
            case "minecraft:cow" -> verifyHolderVariant(
                    entity, expected.variant(), DataComponents.COW_VARIANT);
            case "minecraft:frog" -> verifyHolderVariant(
                    entity, expected.variant(), DataComponents.FROG_VARIANT);
            case "minecraft:pig" -> verifyHolderVariant(
                    entity, expected.variant(), DataComponents.PIG_VARIANT);
            case "minecraft:wolf" -> verifyHolderVariant(
                    entity, expected.variant(), DataComponents.WOLF_VARIANT);
            default -> throw new IllegalStateException(
                    "Unsupported client variant escaped validation.");
        }
    }

    private static <T> void verifyHolderVariant(
            Entity entity, String expected, DataComponentType<Holder<T>> component) {
        Holder<T> actual = entity.get(component);
        String actualId = actual == null
                ? null
                : actual.unwrapKey().map(key -> key.identifier().toString()).orElse(null);
        if (!expected.equals(actualId)) {
            throw new ObservationPendingException(
                    "Client has not received the exact data-driven entity variant.");
        }
    }

    private static Map<String, Object> expectedObservedFixture(
            Scene scene, Representation representation) {
        Fixture fixture = scene.fixture();
        if (fixture.kind().equals("measurement_control")) {
            return Map.of(
                    "strategy", "measurement_control",
                    "targetKind", scene.targetKind().id(),
                    "stateId", fixture.stateId(),
                    "baseSceneId", scene.baseSceneId(),
                    "subjectOmitted", true);
        }
        RepresentationState state = representation.state(fixture.stateId());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("strategy", representation.strategy().id());
        result.put("targetKind", scene.targetKind().id());
        result.put("stateId", fixture.stateId());
        switch (representation.strategy()) {
            case ITEM_STACK -> {
                result.put("itemStack", state.itemStack().toProtocolValue());
                result.put("equipped", scene.context() == CapturePlan.Context.WORLD);
            }
            case NATIVE_BLOCK_STATE, BLOCK_DISPLAY -> {
                result.put("layout", fixture.layout());
                result.put("orientation", fixture.orientation());
                result.put("animationTick", fixture.animationTick());
                result.put("blockPosition", fixture.blockPosition().toProtocolValue());
                result.put("backdrop", fixture.backdrop());
                result.put("overlapCopies", fixture.overlapCopies());
                if (fixture.layout().equals("inventory")
                        && representation.review().inventoryItemStack() != null) {
                    result.put("inventoryItemStack",
                            representation.review().inventoryItemStack().toProtocolValue());
                }
                if (representation.strategy() == CapturePlan.RepresentationStrategy.NATIVE_BLOCK_STATE) {
                    result.put("blockState", state.blockState().toProtocolValue());
                } else {
                    result.put("blockDisplay", state.blockDisplay().toProtocolValue());
                }
            }
            case EQUIPPABLE_HEAD -> {
                result.put("subject", fixture.subject());
                result.put("framing", fixture.framing());
                result.put("pose", fixture.pose());
                result.put("viewAngle", fixture.viewAngle());
                result.put("cameraDistance", fixture.cameraDistance());
                result.put("renderMode", representation.headwear().renderMode());
                if (!fixture.subject().equals("bare_control")) {
                    result.put("headItemStack", state.itemStack().toProtocolValue());
                }
                if (fixture.chestArmor()) {
                    result.put("chestArmorItemStack",
                            representation.review().chestArmorItemStack().toProtocolValue());
                }
            }
            case NATIVE_ENTITY -> {
                putEntityFixture(result, fixture);
                result.put("entity", state.entity().toProtocolValue());
            }
            case NATIVE_PLACEABLE_BLOCK -> {
                putPlaceableFixture(result, fixture);
                result.put("blockState", state.blockState().toProtocolValue());
            }
            case NATIVE_PLACEABLE_ENTITY -> {
                putPlaceableFixture(result, fixture);
                result.put("entity", state.entity().toProtocolValue());
            }
            case DISPLAY_RIG -> {
                if (scene.targetKind() == CapturePlan.TargetKind.ENTITY) {
                    putEntityFixture(result, fixture);
                } else {
                    putPlaceableFixture(result, fixture);
                }
                result.put("displayRig", state.displayRig().toProtocolValue());
            }
        }
        return Map.copyOf(result);
    }

    private static void putEntityFixture(Map<String, Object> result, Fixture fixture) {
        result.put("pose", fixture.pose());
        result.put("angle", fixture.angle());
        result.put("showPlayerScale", fixture.showPlayerScale());
        result.put("animationTick", fixture.animationTick());
    }

    private static void putPlaceableFixture(Map<String, Object> result, Fixture fixture) {
        result.put("orientation", fixture.orientation());
        result.put("attachment", fixture.attachment());
        result.put("distance", fixture.distance());
        result.put("occluded", fixture.occluded());
        result.put("animationTick", fixture.animationTick());
        result.put("context", fixture.context());
        result.put("subjectPosition", fixture.subjectPosition().toProtocolValue());
    }

    static final class ObservationPendingException extends IllegalStateException {
        private static final long serialVersionUID = 1L;

        ObservationPendingException(String message) {
            super(message);
        }
    }
}
