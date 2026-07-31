package io.github.rithwikbabu.packwright.capture;

import com.mojang.brigadier.StringReader;
import com.mojang.datafixers.util.Pair;
import com.mojang.math.Transformation;
import io.github.rithwikbabu.packwright.capture.mixin.BlockDisplayAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.DisplayAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.InteractionAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.ItemDisplayAccessor;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.DisplayNode;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.DisplayRig;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.BlockStateSpec;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.EntitySpec;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Fixture;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.ItemStackSpec;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Representation;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.RepresentationState;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Scene;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Vec3;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.commands.arguments.item.ItemInput;
import net.minecraft.commands.arguments.item.ItemParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.Registry;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.network.protocol.game.ClientboundChunksBiomesPacket;
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Brightness;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.AgeableMob;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnRequest;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Interaction;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.decoration.Mannequin;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LightBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.joml.Quaternionf;
import org.joml.Vector3f;

/** Compiles the protocol-v3 declarative fixture union into allow-listed game API calls. */
final class SceneFixtureExecutor {
    static final String FIXTURE_TAG = "packwright_capture_fixture";
    static final BlockPos SUBJECT_ORIGIN = new BlockPos(0, 80, 5);
    private static final int MAX_CONTROLLED_FIXTURE_Y = 91;
    static final int OPEN_SKY_PROBE_Y = MAX_CONTROLLED_FIXTURE_Y + 1;

    private SceneFixtureExecutor() {}

    static FixtureEvidence apply(
            ServerLevel level,
            ServerPlayer player,
            Scene scene,
            Representation representation) {
        clearPrevious(level, player);
        configureEnvironment(level, player, scene);
        RepresentationState state = representation.state(scene.fixture().stateId());
        if (state == null) throw new IllegalStateException("Capture state disappeared after validation.");
        return switch (scene.targetKind()) {
            case HELD_ITEM, GUI_ITEM -> FixtureEvidence.item(
                    representation.strategy().id(),
                    scene.fixture().stateId(),
                    state.itemStack().itemId(),
                    scene.context() == CapturePlan.Context.WORLD);
            case BLOCK -> setupBlock(level, state, scene, representation);
            case HEADWEAR -> setupHeadwear(level, player, state, scene, representation);
            case ENTITY -> setupEntity(level, state, scene, representation);
            case PLACEABLE -> setupPlaceable(level, state, scene, representation);
        };
    }

    static FixtureEvidence applyMeasurementControl(
            ServerLevel level,
            ServerPlayer player,
            Scene control,
            Scene authoritativeBase,
            Representation representation) {
        if (!control.fixture().kind().equals("measurement_control")
                || !control.baseSceneId().equals(authoritativeBase.baseSceneId())
                || !control.fixture().stateId().equals(authoritativeBase.fixture().stateId())) {
            throw new IllegalStateException(
                    "Measurement control lost its exact authoritative-scene binding.");
        }
        clearPrevious(level, player);
        configureEnvironment(level, player, authoritativeBase);
        List<EntityHandle> retainedReferenceHandles = new ArrayList<>();
        switch (control.targetKind()) {
            case BLOCK -> stageBlockControl(level, authoritativeBase);
            case HEADWEAR -> stageHeadwearControl(player, authoritativeBase);
            case ENTITY -> {
                if (authoritativeBase.fixture().showPlayerScale()) {
                    retainedReferenceHandles.add(EntityHandle.of(spawnScaleReference(level)));
                }
            }
            case PLACEABLE -> addPlaceableContext(
                    level,
                    authoritativeBase.fixture(),
                    subjectPosition(authoritativeBase));
            default -> throw new IllegalStateException(
                    "Item targets cannot declare empty-subject measurement controls.");
        }
        return FixtureEvidence.measurementControl(
                control.fixture().stateId(), retainedReferenceHandles);
    }

    private static void stageBlockControl(ServerLevel level, Scene base) {
        BlockPos origin = subjectPosition(base);
        switch (base.fixture().layout()) {
            case "single", "inventory" -> { }
            case "adjacency" -> {
                // Preserve only the ordinary opaque-neighbor context. Repeated
                // subject copies are omitted with the measured subject.
                level.setBlock(origin.west(), Blocks.STONE.defaultBlockState(), 3);
            }
            case "culling" -> {
                level.setBlock(origin.east(), Blocks.STONE.defaultBlockState(), 3);
                level.setBlock(origin.north(), Blocks.STONE.defaultBlockState(), 3);
                level.setBlock(origin.below(), Blocks.STONE.defaultBlockState(), 3);
            }
            case "transparency_light", "transparency_overlap" ->
                    level.setBlock(origin.south(2), Blocks.CONCRETE.white().defaultBlockState(), 3);
            case "transparency_dark" ->
                    level.setBlock(origin.south(2), Blocks.CONCRETE.black().defaultBlockState(), 3);
            default -> throw new IllegalStateException(
                    "Unsupported block control layout escaped validation.");
        }
    }

    private static void stageHeadwearControl(ServerPlayer player, Scene base) {
        player.setInvisible(false);
        player.setYRot(base.fixture().subjectYaw());
        player.setYHeadRot(base.fixture().subjectYaw());
        player.setYBodyRot(base.fixture().subjectYaw());
        applyPlayerPose(player, base.fixture().pose());
        player.setItemSlot(EquipmentSlot.HEAD, ItemStack.EMPTY);
        player.setItemSlot(EquipmentSlot.CHEST, ItemStack.EMPTY);
    }

    static int requiredAnimationTicks(Scene scene) {
        if (scene.fixture().kind().equals("measurement_control")) return 0;
        return switch (scene.targetKind()) {
            case BLOCK, ENTITY, PLACEABLE -> scene.fixture().animationTick();
            default -> 0;
        };
    }

    static int turntableYaw(int angle) {
        return Math.floorMod(angle + 180, 360);
    }

    static float orientationYaw(String orientation) {
        return switch (orientation) {
            case "north" -> 0.0F;
            case "east" -> 90.0F;
            case "south" -> 180.0F;
            case "west" -> 270.0F;
            default -> throw new IllegalArgumentException("Unsupported cardinal orientation.");
        };
    }

    static ItemStack parseItem(ItemStackSpec planned, net.minecraft.core.RegistryAccess registries) {
        try {
            String componentSyntax = planned.components().entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .map(entry -> entry.getKey() + '=' + entry.getValue())
                    .collect(java.util.stream.Collectors.joining(","));
            String declaredSyntax = planned.itemId()
                    + (componentSyntax.isEmpty() ? "" : '[' + componentSyntax + ']');
            StringReader declaredReader = new StringReader(declaredSyntax);
            ItemInput declaredInput = new ItemParser(registries).parse(declaredReader);
            if (declaredReader.canRead()) {
                throw new IllegalStateException(
                        "Declared item components contain trailing input at cursor "
                                + declaredReader.getCursor() + '.');
            }
            ItemStack declared = declaredInput.createItemStack(planned.count());
            String actualItemId = BuiltInRegistries.ITEM.getKey(declared.getItem()).toString();
            if (!actualItemId.equals(planned.itemId())) {
                throw new IllegalStateException(
                        "Parsed item identifier does not match declarative capture provenance.");
            }
            return declared;
        } catch (com.mojang.brigadier.exceptions.CommandSyntaxException error) {
            throw new IllegalStateException("Minecraft rejected the hash-bound item syntax.", error);
        }
    }

    static BlockState parseBlockState(ServerLevel level, BlockStateSpec planned) {
        try {
            return BlockStateParser.parseForBlock(
                            level.registryAccess().lookupOrThrow(Registries.BLOCK),
                            planned.commandSyntax(),
                            false)
                    .blockState();
        } catch (com.mojang.brigadier.exceptions.CommandSyntaxException error) {
            throw new IllegalStateException("Minecraft rejected the hash-bound block state.", error);
        }
    }

    private static void clearPrevious(ServerLevel level, ServerPlayer player) {
        List<Entity> discard = new ArrayList<>();
        for (Entity entity : level.getAllEntities()) {
            if (entity != player && entity.entityTags().contains(FIXTURE_TAG)) discard.add(entity);
        }
        discard.forEach(Entity::discard);
        BlockState air = Blocks.AIR.defaultBlockState();
        for (int x = -8; x <= 8; x++) {
            for (int y = 80; y <= MAX_CONTROLLED_FIXTURE_Y; y++) {
                for (int z = -3; z <= 11; z++) {
                    level.setBlock(new BlockPos(x, y, z), air, 3);
                }
            }
        }
        player.setItemSlot(EquipmentSlot.HEAD, ItemStack.EMPTY);
        player.setItemSlot(EquipmentSlot.CHEST, ItemStack.EMPTY);
        player.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
        player.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
    }

    static void configureEnvironment(ServerLevel level, ServerPlayer player, Scene scene) {
        BlockPos subject = subjectPosition(scene);
        BlockPos lightingSample = lightingSamplePosition(scene);
        // Sky-light attestation is deliberately independent of subject
        // geometry. In particular, a ceiling-attached placeable has an
        // ordinary-block ceiling immediately above the subject, which
        // legitimately attenuates light at the subject cell. Keep a canonical
        // air probe above every controlled fixture instead of weakening the
        // exact sky-light equality check.
        level.setBlock(skyLightProbePosition(scene), Blocks.AIR.defaultBlockState(), 3);
        CapturePlan.LightSource plannedLight = scene.environment().lightSource();
        BlockPos lightPosition = lightingSample.offset(
                plannedLight.offset().x(), plannedLight.offset().y(), plannedLight.offset().z());
        if (plannedLight.level() == 0) {
            level.setBlock(lightPosition, Blocks.AIR.defaultBlockState(), 3);
        } else {
            BlockState light = Blocks.LIGHT.defaultBlockState()
                    .setValue(LightBlock.LEVEL, plannedLight.level());
            level.setBlock(lightPosition, light, 3);
        }
        level.dimensionType().defaultClock().ifPresent(clock -> {
            level.getServer().clockManager().setTotalTicks(clock, scene.environment().time());
            level.getServer().clockManager().setPaused(clock, true);
        });
        Holder.Reference<net.minecraft.world.level.biome.Biome> biome = level.registryAccess()
                .lookupOrThrow(Registries.BIOME)
                .get(Identifier.parse(scene.environment().biome()))
                .orElseThrow(() -> new IllegalStateException(
                        "Minecraft has no exact biome from capture provenance."));
        List<net.minecraft.world.level.chunk.LevelChunk> chunks = new ArrayList<>();
        for (int chunkX = -2; chunkX <= 2; chunkX++) {
            for (int chunkZ = -2; chunkZ <= 2; chunkZ++) {
                var chunk = level.getChunk(chunkX, chunkZ);
                chunk.fillBiomesFromNoise(
                        (quartX, quartY, quartZ, sampler) -> biome,
                        level.getChunkSource().randomState().sampler());
                chunk.markUnsaved();
                chunks.add(chunk);
            }
        }
        String appliedBiome = level.getBiome(subject)
                .unwrapKey()
                .map(key -> key.identifier().toString())
                .orElse(null);
        if (!scene.environment().biome().equals(appliedBiome)) {
            throw new IllegalStateException(
                    "Minecraft server did not retain the exact studio biome: actual="
                            + appliedBiome + " expected=" + scene.environment().biome() + '.');
        }
        player.connection.send(ClientboundChunksBiomesPacket.forChunks(chunks));
    }

    static BlockPos lightingSamplePosition(Scene scene) {
        BlockPos subject = subjectPosition(scene);
        return switch (scene.fixture().kind()) {
            // Read the environment immediately above occupied native blocks;
            // the block cell itself is a model output (for example, leaves
            // legitimately attenuate its raw skylight value).
            case "native_block_state", "native_placeable_block" -> subject.above();
            default -> subject;
        };
    }

    static BlockPos skyLightProbePosition(Scene scene) {
        return skyLightProbePosition(subjectPosition(scene));
    }

    static BlockPos skyLightProbePosition(BlockPos subject) {
        return new BlockPos(subject.getX(), OPEN_SKY_PROBE_Y, subject.getZ());
    }

    static BlockPos subjectPosition(Scene scene) {
        if (scene.targetKind() == CapturePlan.TargetKind.BLOCK) {
            return new BlockPos(
                    scene.fixture().blockPosition().x(),
                    scene.fixture().blockPosition().y(),
                    scene.fixture().blockPosition().z());
        }
        if (scene.targetKind() == CapturePlan.TargetKind.PLACEABLE) {
            return new BlockPos(
                    scene.fixture().subjectPosition().x(),
                    scene.fixture().subjectPosition().y(),
                    scene.fixture().subjectPosition().z());
        }
        return SUBJECT_ORIGIN;
    }


    private static FixtureEvidence setupBlock(
            ServerLevel level,
            RepresentationState state,
            Scene scene,
            Representation representation) {
        if (scene.fixture().layout().equals("inventory")) {
            return FixtureEvidence.inventory(
                    representation.strategy().id(),
                    scene.fixture().stateId(),
                    representation.review().inventoryItemStack().itemId());
        }
        BlockPos origin = new BlockPos(
                scene.fixture().blockPosition().x(),
                scene.fixture().blockPosition().y(),
                scene.fixture().blockPosition().z());
        if (state.blockState() != null) {
            BlockState block = parseBlockState(level, state.blockState());
            placeBlockLayout(level, origin, block, scene.fixture().layout());
            if (!level.getBlockState(origin).equals(block)) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact planned block state.");
            }
            return FixtureEvidence.block(
                    representation.strategy().id(),
                    scene.fixture().stateId(),
                    state.blockState());
        }
        DisplayNode node = state.blockDisplay();
        if (node == null) {
            throw new IllegalStateException("Block-display state disappeared after validation.");
        }
        List<EntityHandle> handles =
                spawnBlockDisplayLayout(level, node, origin, scene.fixture().layout());
        return FixtureEvidence.blockDisplay(
                representation.strategy().id(),
                scene.fixture().stateId(),
                node,
                handles);
    }

    private static List<EntityHandle> spawnBlockDisplayLayout(
            ServerLevel level, DisplayNode node, BlockPos origin, String layout) {
        DisplayRig single = new DisplayRig(List.of(node), null);
        List<EntityHandle> handles = new ArrayList<>(spawnDisplayRig(level, single, 0.0F, origin));
        switch (layout) {
            case "single" -> { }
            case "adjacency" -> {
                handles.addAll(spawnDisplayRig(level, single, 0.0F, origin.east()));
                handles.addAll(spawnDisplayRig(level, single, 0.0F, origin.south()));
                level.setBlock(origin.west(), Blocks.STONE.defaultBlockState(), 3);
            }
            case "culling" -> {
                level.setBlock(origin.east(), Blocks.STONE.defaultBlockState(), 3);
                level.setBlock(origin.north(), Blocks.STONE.defaultBlockState(), 3);
                level.setBlock(origin.below(), Blocks.STONE.defaultBlockState(), 3);
            }
            case "transparency_light" ->
                    level.setBlock(origin.south(2), Blocks.CONCRETE.white().defaultBlockState(), 3);
            case "transparency_dark" ->
                    level.setBlock(origin.south(2), Blocks.CONCRETE.black().defaultBlockState(), 3);
            case "transparency_overlap" -> {
                handles.addAll(spawnDisplayRig(level, single, 0.0F, origin.south()));
                level.setBlock(origin.south(2), Blocks.CONCRETE.white().defaultBlockState(), 3);
            }
            case "inventory" -> throw new IllegalStateException(
                    "Inventory block displays must not create a world fixture.");
            default -> throw new IllegalStateException(
                    "Unsupported block-display layout after validation.");
        }
        return List.copyOf(handles);
    }

    private static void placeBlockLayout(
            ServerLevel level, BlockPos origin, BlockState subject, String layout) {
        level.setBlock(origin, subject, 3);
        switch (layout) {
            case "single", "inventory" -> { }
            case "adjacency" -> {
                level.setBlock(origin.east(), subject, 3);
                level.setBlock(origin.south(), subject, 3);
                level.setBlock(origin.west(), Blocks.STONE.defaultBlockState(), 3);
            }
            case "culling" -> {
                level.setBlock(origin.east(), Blocks.STONE.defaultBlockState(), 3);
                level.setBlock(origin.north(), Blocks.STONE.defaultBlockState(), 3);
                level.setBlock(origin.below(), Blocks.STONE.defaultBlockState(), 3);
            }
            case "transparency_light" ->
                    level.setBlock(origin.south(2), Blocks.CONCRETE.white().defaultBlockState(), 3);
            case "transparency_dark" ->
                    level.setBlock(origin.south(2), Blocks.CONCRETE.black().defaultBlockState(), 3);
            case "transparency_overlap" -> {
                level.setBlock(origin.south(), subject, 3);
                level.setBlock(origin.south(2), Blocks.CONCRETE.white().defaultBlockState(), 3);
            }
            default -> throw new IllegalStateException("Unsupported block layout after validation.");
        }
    }

    private static FixtureEvidence setupHeadwear(
            ServerLevel level,
            ServerPlayer player,
            RepresentationState state,
            Scene scene,
            Representation representation) {
        Fixture fixture = scene.fixture();
        ItemStack stack = parseItem(state.itemStack(), level.registryAccess());
        ItemStack chestArmor = fixture.chestArmor()
                ? parseItem(representation.review().chestArmorItemStack(), level.registryAccess())
                : ItemStack.EMPTY;
        player.setInvisible(fixture.subject().equals("armor_stand"));
        player.setYRot(fixture.subjectYaw());
        player.setYHeadRot(fixture.subjectYaw());
        player.setYBodyRot(fixture.subjectYaw());
        applyPlayerPose(player, fixture.pose());
        if (fixture.subject().equals("bare_control")) {
            player.setItemSlot(EquipmentSlot.HEAD, ItemStack.EMPTY);
        } else if (fixture.subject().equals("player")) {
            player.setItemSlot(EquipmentSlot.HEAD, stack);
            player.setItemSlot(EquipmentSlot.CHEST, chestArmor);
            if (!exactStack(player.getItemBySlot(EquipmentSlot.HEAD), stack)) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact equipped player head item.");
            }
            if (fixture.chestArmor()
                    && !exactStack(player.getItemBySlot(EquipmentSlot.CHEST), chestArmor)) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact headwear compatibility chest armor.");
            }
        } else {
            ArmorStand stand = EntityTypes.ARMOR_STAND.create(level, EntitySpawnReason.COMMAND);
            if (stand == null) throw new IllegalStateException("Minecraft could not create the armor stand fixture.");
            stand.addTag(FIXTURE_TAG);
            stand.setNoGravity(true);
            stand.setSilent(true);
            stand.setInvulnerable(true);
            stand.setPos(SUBJECT_ORIGIN.getX() + 0.5, SUBJECT_ORIGIN.getY(), SUBJECT_ORIGIN.getZ() + 0.5);
            stand.setYRot(fixture.subjectYaw());
            stand.setYHeadRot(fixture.subjectYaw());
            stand.setYBodyRot(fixture.subjectYaw());
            stand.setItemSlot(EquipmentSlot.HEAD, stack);
            if (!exactStack(stand.getItemBySlot(EquipmentSlot.HEAD), stack)) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact armor-stand head item.");
            }
            if (!level.addFreshEntity(stand)) {
                throw new IllegalStateException("Minecraft rejected the armor stand fixture.");
            }
            return FixtureEvidence.headwear(
                    representation.strategy().id(),
                    fixture.stateId(),
                    fixture.subject(),
                    representation.headwear().renderMode(),
                    state.itemStack().itemId(),
                    null,
                    List.of(EntityHandle.of(stand)));
        }
        return FixtureEvidence.headwear(
                representation.strategy().id(),
                fixture.stateId(),
                fixture.subject(),
                representation.headwear().renderMode(),
                fixture.subject().equals("bare_control") ? null : state.itemStack().itemId(),
                fixture.chestArmor()
                        ? representation.review().chestArmorItemStack().itemId()
                        : null,
                List.of());
    }

    private static void applyPlayerPose(ServerPlayer player, String pose) {
        player.setDeltaMovement(0, 0, 0);
        player.walkAnimation.stop();
        player.setPose(switch (pose) {
            case "idle", "walk" -> Pose.STANDING;
            case "crouch" -> Pose.CROUCHING;
            case "swim" -> Pose.SWIMMING;
            case "glide" -> Pose.FALL_FLYING;
            default -> throw new IllegalStateException("Unsupported player pose escaped validation.");
        });
        if (pose.equals("walk")) player.walkAnimation.update(1.0F, 1.0F, 1.0F);
    }

    private static FixtureEvidence setupEntity(
            ServerLevel level,
            RepresentationState state,
            Scene scene,
            Representation representation) {
        if (state.entity() != null) {
            Entity entity = spawnNativeEntity(
                    level, state.entity(), scene.fixture(), SUBJECT_ORIGIN);
            Entity scaleReference = scene.fixture().showPlayerScale()
                    ? spawnScaleReference(level)
                    : null;
            List<EntityHandle> handles = new ArrayList<>();
            handles.add(EntityHandle.of(entity));
            if (scaleReference != null) handles.add(EntityHandle.of(scaleReference));
            return FixtureEvidence.entity(
                    representation.strategy().id(), scene.fixture().stateId(), state.entity(),
                    scaleReference == null ? null : "minecraft:mannequin",
                    List.copyOf(handles));
        }
        DisplayRig rig = state.displayRig();
        List<EntityHandle> handles = new ArrayList<>(spawnDisplayRig(
                level, rig, turntableYaw(scene.fixture().angle()), SUBJECT_ORIGIN));
        Entity scaleReference = scene.fixture().showPlayerScale()
                ? spawnScaleReference(level)
                : null;
        if (scaleReference != null) handles.add(EntityHandle.of(scaleReference));
        return FixtureEvidence.display(
                representation.strategy().id(),
                scene.fixture().stateId(),
                rig,
                scaleReference == null ? null : "minecraft:mannequin",
                List.copyOf(handles));
    }

    private static FixtureEvidence setupPlaceable(
            ServerLevel level,
            RepresentationState state,
            Scene scene,
            Representation representation) {
        Fixture fixture = scene.fixture();
        float yaw = orientationYaw(fixture.orientation());
        BlockPos origin = subjectPosition(scene);
        if (state.blockState() != null) {
            BlockState block = parseBlockState(level, state.blockState());
            level.setBlock(origin, block, 3);
            if (!level.getBlockState(origin).equals(block)) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact placeable block state.");
            }
            addPlaceableContext(level, fixture, origin);
            return FixtureEvidence.block(
                    representation.strategy().id(), fixture.stateId(), state.blockState());
        }
        if (state.entity() != null) {
            Entity entity = spawnNativeEntity(level, state.entity(), fixture, origin);
            if (Float.compare(entity.getYRot(), yaw) != 0) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact native placeable orientation.");
            }
            addPlaceableContext(level, fixture, origin);
            return FixtureEvidence.entity(
                    representation.strategy().id(), fixture.stateId(), state.entity(), null,
                    List.of(EntityHandle.of(entity)));
        }
        DisplayRig rig = state.displayRig();
        List<EntityHandle> handles = spawnDisplayRig(level, rig, yaw, origin);
        addPlaceableContext(level, fixture, origin);
        return FixtureEvidence.display(
                representation.strategy().id(), fixture.stateId(), rig, null, handles);
    }

    private static void addPlaceableContext(
            ServerLevel level, Fixture fixture, BlockPos origin) {
        PlaceableStudioGeometry.requiredStoneBlocks(
                        fixture.attachment(),
                        fixture.orientation(),
                        fixture.context(),
                        fixture.occluded(),
                        origin)
                .forEach(position ->
                        level.setBlock(position, Blocks.STONE.defaultBlockState(), 3));
    }

    private static Entity spawnScaleReference(ServerLevel level) {
        Mannequin mannequin = EntityTypes.MANNEQUIN.create(level, EntitySpawnReason.COMMAND);
        if (mannequin == null) {
            throw new IllegalStateException("Minecraft could not create the mannequin scale reference.");
        }
        mannequin.addTag(FIXTURE_TAG);
        mannequin.setNoGravity(true);
        mannequin.setSilent(true);
        mannequin.setInvulnerable(true);
        mannequin.setPos(
                SUBJECT_ORIGIN.getX() + 2.5,
                SUBJECT_ORIGIN.getY(),
                SUBJECT_ORIGIN.getZ() + 0.5);
        mannequin.setYRot(180.0F);
        if (!level.addFreshEntity(mannequin)) {
            throw new IllegalStateException("Minecraft rejected the mannequin scale reference.");
        }
        return mannequin;
    }

    private static Entity spawnNativeEntity(
            ServerLevel level, EntitySpec spec, Fixture fixture, BlockPos origin) {
        Identifier id = Identifier.parse(spec.entityType());
        EntityType<?> type = BuiltInRegistries.ENTITY_TYPE.getValue(id);
        if (type == null || !EntityType.getKey(type).equals(id)) {
            throw new IllegalStateException("Minecraft has no exact entity type from capture provenance.");
        }
        Entity entity = type.create(
                level, new EntitySpawnRequest(EntitySpawnReason.COMMAND, true));
        if (entity == null) {
            throw new IllegalStateException(
                    "Minecraft could not create planned entity type '" + spec.entityType()
                            + "' for scene '" + fixture.kind() + '/' + fixture.stateId()
                            + "' (pose=" + fixture.pose() + ").");
        }
        entity.addTag(FIXTURE_TAG);
        entity.setSilent(true);
        entity.setInvulnerable(true);
        entity.setPos(origin.getX() + 0.5, origin.getY(), origin.getZ() + 0.5);
        float plannedYaw = fixture.pose() != null
                ? (float) turntableYaw(fixture.angle())
                : fixture.orientation() != null ? orientationYaw(fixture.orientation()) : 0.0F;
        // Rotation belongs to the initial tracked entity state. Setting only
        // yRot after addFreshEntity leaves the client on the spawn packet's
        // default yaw until a later movement packet (and armor stands render
        // from their living body/head rotations as well).
        entity.setYRot(plannedYaw);
        if (entity instanceof LivingEntity living) {
            living.setYBodyRot(plannedYaw);
            living.setYHeadRot(plannedYaw);
        }
        if (entity instanceof Mob mob) {
            mob.setNoAi(true);
            mob.setPersistenceRequired();
            mob.setBaby(spec.baby());
        } else if (spec.baby()) {
            throw new IllegalStateException("Planned entity does not support the declared baby state.");
        }
        applyVariant(level, entity, spec);
        if (entity instanceof LivingEntity living) {
            living.walkAnimation.stop();
        }
        if (!level.addFreshEntity(entity)) {
            throw new IllegalStateException("Minecraft rejected the planned native entity fixture.");
        }
        // Apply equipment only after the entity enters the server tracker so
        // Minecraft emits real equipment synchronization packets. Assigning
        // it pre-spawn is not consistently included in the initial client
        // entity state across all entity render samples.
        if (entity instanceof LivingEntity living) {
            List<Pair<EquipmentSlot, ItemStack>> synchronizedEquipment = new ArrayList<>();
            for (Map.Entry<String, ItemStackSpec> entry : spec.equipment().entrySet()) {
                EquipmentSlot slot = equipmentSlot(entry.getKey());
                ItemStack stack = parseItem(entry.getValue(), level.registryAccess());
                living.setItemSlot(slot, stack);
                synchronizedEquipment.add(Pair.of(slot, stack.copy()));
            }
            if (!synchronizedEquipment.isEmpty()) {
                level.getChunkSource().sendToTrackingPlayers(
                        entity,
                        new ClientboundSetEquipmentPacket(entity.getId(), synchronizedEquipment));
            }
        }
        // Animation state must be applied only after the entity is tracked. In
        // particular, LivingEntity.swing broadcasts the animation packet to
        // tracking clients and is not authoritative when invoked pre-spawn.
        if (entity instanceof LivingEntity living && fixture.pose() != null) {
            if (fixture.pose().equals("walk")) {
                living.walkAnimation.update(1.0F, 1.0F, 1.0F);
            } else if (fixture.pose().equals("attack")) {
                living.swing(InteractionHand.MAIN_HAND, true);
            }
        }
        if (level.getEntity(entity.getId()) != entity
                || !EntityType.getKey(entity.getType()).toString().equals(spec.entityType())
                || (entity instanceof LivingEntity livingEntity && livingEntity.isBaby())
                        != spec.baby()) {
            throw new IllegalStateException(
                    "Minecraft did not retain the exact native entity type or age state.");
        }
        verifyVariant(entity, spec);
        if (entity instanceof LivingEntity living) {
            for (Map.Entry<String, ItemStackSpec> entry : spec.equipment().entrySet()) {
                ItemStack expected = parseItem(entry.getValue(), level.registryAccess());
                if (!exactStack(living.getItemBySlot(equipmentSlot(entry.getKey())), expected)) {
                    throw new IllegalStateException(
                            "Minecraft did not retain exact native entity equipment.");
                }
            }
        }
        return entity;
    }

    private static void verifyVariant(Entity entity, EntitySpec spec) {
        if (spec.variant() == null) return;
        switch (spec.entityType()) {
            case "minecraft:cat" -> verifyHolderVariant(entity, spec.variant(), DataComponents.CAT_VARIANT);
            case "minecraft:chicken" -> verifyHolderVariant(
                    entity, spec.variant(), DataComponents.CHICKEN_VARIANT);
            case "minecraft:cow" -> verifyHolderVariant(entity, spec.variant(), DataComponents.COW_VARIANT);
            case "minecraft:frog" -> verifyHolderVariant(entity, spec.variant(), DataComponents.FROG_VARIANT);
            case "minecraft:pig" -> verifyHolderVariant(entity, spec.variant(), DataComponents.PIG_VARIANT);
            case "minecraft:wolf" -> verifyHolderVariant(entity, spec.variant(), DataComponents.WOLF_VARIANT);
            default -> throw new IllegalStateException(
                    "Unsupported native variant escaped plan validation.");
        }
    }

    private static <T> void verifyHolderVariant(
            Entity entity, String expectedId, DataComponentType<Holder<T>> component) {
        Holder<T> actual = entity.get(component);
        String actualId = actual == null
                ? null
                : actual.unwrapKey().map(key -> key.identifier().toString()).orElse(null);
        if (!expectedId.equals(actualId)) {
            throw new IllegalStateException(
                    "Minecraft did not retain the exact data-driven entity variant.");
        }
    }

    private static <T> void applyHolderVariant(
            ServerLevel level,
            Entity entity,
            String variant,
            ResourceKey<? extends Registry<T>> registryKey,
            DataComponentType<Holder<T>> component) {
        Holder.Reference<T> holder = level.registryAccess()
                .lookupOrThrow(registryKey)
                .get(Identifier.parse(variant))
                .orElseThrow(() -> new IllegalStateException(
                        "Minecraft has no exact data-driven entity variant from capture provenance."));
        entity.setComponent(component, holder);
    }

    private static void applyVariant(ServerLevel level, Entity entity, EntitySpec spec) {
        if (spec.variant() == null) return;
        switch (spec.entityType()) {
            case "minecraft:cat" -> applyHolderVariant(
                    level, entity, spec.variant(), Registries.CAT_VARIANT, DataComponents.CAT_VARIANT);
            case "minecraft:chicken" -> applyHolderVariant(
                    level, entity, spec.variant(), Registries.CHICKEN_VARIANT, DataComponents.CHICKEN_VARIANT);
            case "minecraft:cow" -> applyHolderVariant(
                    level, entity, spec.variant(), Registries.COW_VARIANT, DataComponents.COW_VARIANT);
            case "minecraft:frog" -> applyHolderVariant(
                    level, entity, spec.variant(), Registries.FROG_VARIANT, DataComponents.FROG_VARIANT);
            case "minecraft:pig" -> applyHolderVariant(
                    level, entity, spec.variant(), Registries.PIG_VARIANT, DataComponents.PIG_VARIANT);
            case "minecraft:wolf" -> applyHolderVariant(
                    level, entity, spec.variant(), Registries.WOLF_VARIANT, DataComponents.WOLF_VARIANT);
            default -> throw new IllegalStateException("Unsupported native variant escaped plan validation.");
        }
    }

    private static EquipmentSlot equipmentSlot(String slot) {
        return switch (slot) {
            case "head" -> EquipmentSlot.HEAD;
            case "chest" -> EquipmentSlot.CHEST;
            case "legs" -> EquipmentSlot.LEGS;
            case "feet" -> EquipmentSlot.FEET;
            case "mainhand" -> EquipmentSlot.MAINHAND;
            case "offhand" -> EquipmentSlot.OFFHAND;
            default -> throw new IllegalStateException("Unsupported equipment slot escaped validation.");
        };
    }

    private static List<EntityHandle> spawnDisplayRig(
            ServerLevel level, DisplayRig rig, float orientationYaw, BlockPos origin) {
        List<EntityHandle> handles = new ArrayList<>();
        double originX = origin.getX() + 0.5;
        double originY = origin.getY();
        double originZ = origin.getZ() + 0.5;
        for (DisplayNode node : rig.nodes()) {
            Display display;
            if (node.kind().equals("block_display")) {
                Display.BlockDisplay block = EntityTypes.BLOCK_DISPLAY.create(level, EntitySpawnReason.COMMAND);
                if (block == null) throw new IllegalStateException("Minecraft could not create block_display.");
                BlockState expectedBlock = parseBlockState(level, node.blockState());
                BlockDisplayAccessor blockAccessor = (BlockDisplayAccessor) block;
                blockAccessor.packwrightCapture$setBlockState(expectedBlock);
                if (!blockAccessor.packwrightCapture$getBlockState().equals(expectedBlock)) {
                    throw new IllegalStateException(
                            "Minecraft did not retain the exact block-display block state.");
                }
                display = block;
            } else {
                Display.ItemDisplay item = EntityTypes.ITEM_DISPLAY.create(level, EntitySpawnReason.COMMAND);
                if (item == null) throw new IllegalStateException("Minecraft could not create item_display.");
                ItemDisplayAccessor accessor = (ItemDisplayAccessor) item;
                ItemStack expectedItem = parseItem(node.itemStack(), level.registryAccess());
                ItemDisplayContext expectedContext = itemDisplayContext(node.itemDisplayContext());
                accessor.packwrightCapture$setItemStack(expectedItem);
                accessor.packwrightCapture$setItemTransform(expectedContext);
                if (!exactStack(accessor.packwrightCapture$getItemStack(), expectedItem)
                        || accessor.packwrightCapture$getItemTransform() != expectedContext) {
                    throw new IllegalStateException(
                            "Minecraft did not retain the exact item-display stack or context.");
                }
                display = item;
            }
            display.addTag(FIXTURE_TAG);
            display.setNoGravity(true);
            display.setSilent(true);
            display.setInvulnerable(true);
            Vec3 rotatedPosition = rotateAroundY(node.position(), orientationYaw);
            display.setPos(
                    originX + rotatedPosition.x(),
                    originY + rotatedPosition.y(),
                    originZ + rotatedPosition.z());
            display.setYRot((float) node.yaw() + orientationYaw);
            display.setXRot((float) node.pitch());
            if (Double.compare(display.getX(), originX + rotatedPosition.x()) != 0
                    || Double.compare(display.getY(), originY + rotatedPosition.y()) != 0
                    || Double.compare(display.getZ(), originZ + rotatedPosition.z()) != 0
                    || Float.compare(display.getYRot(), (float) node.yaw() + orientationYaw) != 0
                    || Float.compare(display.getXRot(), (float) node.pitch()) != 0) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact display position or rotation.");
            }
            DisplayAccessor accessor = (DisplayAccessor) display;
            Transformation expectedTransform = transformation(node.transform());
            accessor.packwrightCapture$setTransformation(expectedTransform);
            accessor.packwrightCapture$setTransformationInterpolationDuration(node.interpolation().duration());
            accessor.packwrightCapture$setTransformationInterpolationDelay(node.interpolation().startDelta());
            accessor.packwrightCapture$setBillboardConstraints(
                    Display.BillboardConstraints.valueOf(node.billboard().toUpperCase(Locale.ROOT)));
            accessor.packwrightCapture$setBrightnessOverride(
                    new Brightness(node.brightness().block(), node.brightness().sky()));
            accessor.packwrightCapture$setShadowRadius((float) node.shadow().radius());
            accessor.packwrightCapture$setShadowStrength((float) node.shadow().strength());
            Display.BillboardConstraints expectedBillboard = Display.BillboardConstraints.valueOf(
                    node.billboard().toUpperCase(Locale.ROOT));
            Brightness expectedBrightness = new Brightness(
                    node.brightness().block(), node.brightness().sky());
            if (!DisplayAccessor.packwrightCapture$createTransformation(display.getEntityData())
                            .equals(expectedTransform)
                    || accessor.packwrightCapture$getTransformationInterpolationDuration()
                            != node.interpolation().duration()
                    || accessor.packwrightCapture$getTransformationInterpolationDelay()
                            != node.interpolation().startDelta()
                    || accessor.packwrightCapture$getBillboardConstraints() != expectedBillboard
                    || !accessor.packwrightCapture$getBrightnessOverride().equals(expectedBrightness)
                    || Float.compare(
                                    accessor.packwrightCapture$getShadowRadius(),
                                    (float) node.shadow().radius())
                            != 0
                    || Float.compare(
                                    accessor.packwrightCapture$getShadowStrength(),
                                    (float) node.shadow().strength())
                            != 0) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact display transform or render properties.");
            }
            if (!level.addFreshEntity(display)) {
                throw new IllegalStateException("Minecraft rejected a display fixture node.");
            }
            if (level.getEntity(display.getId()) != display) {
                throw new IllegalStateException("Minecraft did not retain a display fixture node.");
            }
            handles.add(EntityHandle.of(display));
        }
        if (rig.interaction() != null) {
            Interaction interaction = EntityTypes.INTERACTION.create(level, EntitySpawnReason.COMMAND);
            if (interaction == null) throw new IllegalStateException("Minecraft could not create interaction.");
            interaction.addTag(FIXTURE_TAG);
            interaction.setNoGravity(true);
            interaction.setSilent(true);
            interaction.setInvulnerable(true);
            Vec3 rotatedPosition = rotateAroundY(rig.interaction().position(), orientationYaw);
            interaction.setPos(
                    originX + rotatedPosition.x(),
                    originY + rotatedPosition.y(),
                    originZ + rotatedPosition.z());
            if (Double.compare(interaction.getX(), originX + rotatedPosition.x()) != 0
                    || Double.compare(interaction.getY(), originY + rotatedPosition.y()) != 0
                    || Double.compare(interaction.getZ(), originZ + rotatedPosition.z()) != 0) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact interaction position.");
            }
            InteractionAccessor accessor = (InteractionAccessor) interaction;
            accessor.packwrightCapture$setWidth((float) rig.interaction().width());
            accessor.packwrightCapture$setHeight((float) rig.interaction().height());
            accessor.packwrightCapture$setResponse(false);
            if (Float.compare(accessor.packwrightCapture$getWidth(), (float) rig.interaction().width()) != 0
                    || Float.compare(
                                    accessor.packwrightCapture$getHeight(),
                                    (float) rig.interaction().height())
                            != 0
                    || accessor.packwrightCapture$getResponse()) {
                throw new IllegalStateException(
                        "Minecraft did not retain the exact interaction dimensions or response mode.");
            }
            if (!level.addFreshEntity(interaction)) {
                throw new IllegalStateException("Minecraft rejected the interaction fixture.");
            }
            if (level.getEntity(interaction.getId()) != interaction) {
                throw new IllegalStateException("Minecraft did not retain the interaction fixture.");
            }
            handles.add(EntityHandle.of(interaction));
        }
        return List.copyOf(handles);
    }

    static boolean exactStack(ItemStack actual, ItemStack expected) {
        return actual.getCount() == expected.getCount()
                && ItemStack.isSameItemSameComponents(actual, expected);
    }

    static Vec3 rotateAroundY(Vec3 position, float degrees) {
        double radians = Math.toRadians(degrees);
        double sine = Math.sin(radians);
        double cosine = Math.cos(radians);
        return new Vec3(
                position.x() * cosine - position.z() * sine,
                position.y(),
                position.x() * sine + position.z() * cosine);
    }

    static Transformation transformation(CapturePlan.Transform transform) {
        return new Transformation(
                new Vector3f(
                        (float) transform.translation().x(),
                        (float) transform.translation().y(),
                        (float) transform.translation().z()),
                euler(transform.leftRotation()),
                new Vector3f(
                        (float) transform.scale().x(),
                        (float) transform.scale().y(),
                        (float) transform.scale().z()),
                euler(transform.rightRotation()));
    }

    private static Quaternionf euler(CapturePlan.Vec3 degrees) {
        float factor = (float) (Math.PI / 180.0);
        return new Quaternionf().rotateXYZ(
                (float) degrees.x() * factor,
                (float) degrees.y() * factor,
                (float) degrees.z() * factor);
    }

    static ItemDisplayContext itemDisplayContext(String value) {
        return switch (value) {
            case "none" -> ItemDisplayContext.NONE;
            case "thirdperson_lefthand" -> ItemDisplayContext.THIRD_PERSON_LEFT_HAND;
            case "thirdperson_righthand" -> ItemDisplayContext.THIRD_PERSON_RIGHT_HAND;
            case "firstperson_lefthand" -> ItemDisplayContext.FIRST_PERSON_LEFT_HAND;
            case "firstperson_righthand" -> ItemDisplayContext.FIRST_PERSON_RIGHT_HAND;
            case "head" -> ItemDisplayContext.HEAD;
            case "gui" -> ItemDisplayContext.GUI;
            case "ground" -> ItemDisplayContext.GROUND;
            case "fixed" -> ItemDisplayContext.FIXED;
            default -> throw new IllegalStateException("Unsupported item display context escaped validation.");
        };
    }

    record EntityHandle(int id, UUID uuid) {
        static EntityHandle of(Entity entity) {
            return new EntityHandle(entity.getId(), entity.getUUID());
        }
    }

    record FixtureEvidence(
            String strategy,
            String stateId,
            String equippedItemId,
            Boolean equipReady,
            String headwearSubject,
            String headwearRenderMode,
            String chestArmorItemId,
            Boolean chestArmorReady,
            String inventoryItemId,
            BlockStateSpec placedBlockState,
            String spawnedEntityType,
            String spawnedEntityVariant,
            Boolean spawnedEntityBaby,
            Map<String, ItemStackSpec> spawnedEntityEquipment,
            Integer displayNodeCount,
            Double interactionWidth,
            Double interactionHeight,
            String scaleReference,
            Boolean subjectOmitted,
            List<EntityHandle> entityHandles) {
        static FixtureEvidence item(
                String strategy, String stateId, String itemId, boolean equipReady) {
            return new FixtureEvidence(
                    strategy, stateId, itemId, equipReady ? Boolean.TRUE : null,
                    null, null, null, null, null, null, null, null, null, null, null, null, null,
                    null, null, List.of());
        }

        static FixtureEvidence inventory(String strategy, String stateId, String itemId) {
            return new FixtureEvidence(
                    strategy, stateId, null, null, null, null, null, null, itemId, null,
                    null, null, null, null, null, null, null, null, null, List.of());
        }

        static FixtureEvidence block(
                String strategy,
                String stateId,
                BlockStateSpec blockState) {
            return new FixtureEvidence(
                    strategy, stateId, null, null, null, null, null, null, null, blockState,
                    null, null, null, null, null, null, null, null, null, List.of());
        }

        static FixtureEvidence blockDisplay(
                String strategy,
                String stateId,
                DisplayNode blockDisplay,
                List<EntityHandle> handles) {
            return new FixtureEvidence(
                    strategy, stateId, null, null, null, null, null, null, null,
                    blockDisplay.blockState(), null, null, null, null, 1, null, null, null, null,
                    List.copyOf(handles));
        }

        static FixtureEvidence entity(
                String strategy,
                String stateId,
                EntitySpec entity,
                String scaleReference,
                List<EntityHandle> handles) {
            return new FixtureEvidence(
                    strategy, stateId, null, null, null, null, null, null, null,
                    null, entity.entityType(), entity.variant(), entity.baby(), entity.equipment(),
                    null, null, null, scaleReference, null,
                    List.copyOf(handles));
        }

        static FixtureEvidence headwear(
                String strategy,
                String stateId,
                String subject,
                String renderMode,
                String equippedItemId,
                String chestArmorItemId,
                List<EntityHandle> handles) {
            return new FixtureEvidence(
                    strategy, stateId, equippedItemId,
                    equippedItemId == null ? null : Boolean.TRUE,
                    subject, renderMode, chestArmorItemId,
                    chestArmorItemId == null ? null : Boolean.TRUE,
                    null, null, null, null, null, null, null, null, null, null, null,
                    List.copyOf(handles));
        }

        static FixtureEvidence display(
                String strategy,
                String stateId,
                DisplayRig rig,
                String scaleReference,
                List<EntityHandle> handles) {
            return new FixtureEvidence(
                    strategy, stateId, null, null, null, null, null, null, null,
                    null, null, null, null, null,
                    rig.nodes().size(),
                    rig.interaction() == null ? null : rig.interaction().width(),
                    rig.interaction() == null ? null : rig.interaction().height(),
                    scaleReference, null, List.copyOf(handles));
        }

        static FixtureEvidence measurementControl(
                String stateId, List<EntityHandle> retainedReferenceHandles) {
            return new FixtureEvidence(
                    "measurement_control",
                    stateId,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    Boolean.TRUE,
                    List.copyOf(retainedReferenceHandles));
        }

        Map<String, Object> toReport() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("strategy", strategy);
            result.put("stateId", stateId);
            if (equippedItemId != null) result.put("equippedItemId", equippedItemId);
            if (equipReady != null) result.put("equipReady", equipReady);
            if (headwearSubject != null) result.put("headwearSubject", headwearSubject);
            if (headwearRenderMode != null) result.put("headwearRenderMode", headwearRenderMode);
            if (chestArmorItemId != null) result.put("chestArmorItemId", chestArmorItemId);
            if (chestArmorReady != null) result.put("chestArmorReady", chestArmorReady);
            if (inventoryItemId != null) result.put("inventoryItemId", inventoryItemId);
            if (placedBlockState != null) {
                result.put("placedBlockState", placedBlockState.toProtocolValue());
            }
            if (spawnedEntityType != null) result.put("spawnedEntityType", spawnedEntityType);
            if (spawnedEntityVariant != null) {
                result.put("spawnedEntityVariant", spawnedEntityVariant);
            }
            if (spawnedEntityBaby != null) result.put("spawnedEntityBaby", spawnedEntityBaby);
            if (spawnedEntityEquipment != null) {
                Map<String, Object> equipment = new LinkedHashMap<>();
                spawnedEntityEquipment.forEach(
                        (slot, stack) -> equipment.put(slot, stack.toProtocolValue()));
                result.put("spawnedEntityEquipment", Map.copyOf(equipment));
            }
            if (displayNodeCount != null) result.put("displayNodeCount", displayNodeCount);
            if (interactionWidth != null) result.put("interactionWidth", interactionWidth);
            if (interactionHeight != null) result.put("interactionHeight", interactionHeight);
            if (scaleReference != null) result.put("scaleReference", scaleReference);
            if (subjectOmitted != null) result.put("subjectOmitted", subjectOmitted);
            return Map.copyOf(result);
        }
    }
}
