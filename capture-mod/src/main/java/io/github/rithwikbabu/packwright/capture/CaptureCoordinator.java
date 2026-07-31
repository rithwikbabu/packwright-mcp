package io.github.rithwikbabu.packwright.capture;

import com.mojang.blaze3d.platform.Window;
import com.mojang.blaze3d.systems.DeviceInfo;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.brigadier.StringReader;
import io.github.rithwikbabu.packwright.capture.io.AtomicFiles;
import io.github.rithwikbabu.packwright.capture.io.CanonicalJson;
import io.github.rithwikbabu.packwright.capture.io.Hashing;
import io.github.rithwikbabu.packwright.capture.io.PngEvidence;
import io.github.rithwikbabu.packwright.capture.mixin.AbstractContainerScreenAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.ItemInHandRendererAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.MouseHandlerAccessor;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePaths;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.AnimationState;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Camera;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Context;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Hand;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.PlayerModel;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan.Scene;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.item.ItemInput;
import net.minecraft.commands.arguments.item.ItemParser;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.packs.repository.PackRepository;
import net.minecraft.world.Difficulty;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.saveddata.WeatherData;
import net.minecraft.world.level.storage.ServerLevelData;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class CaptureCoordinator {
    private static final Logger LOGGER = LoggerFactory.getLogger(PackwrightCaptureClient.MOD_ID);
    private static final String REQUIRED_RESOURCE_PACK = "file/packwright-proposal.zip";
    private static final String RESOURCE_RELOAD_STARTED_EXCERPT =
            "Packwright capture resource reload started";
    private static final String RESOURCE_RELOAD_EXCERPT =
            "Packwright capture resource reload completed";
    private static final String RESOURCE_DIAGNOSTICS_EXCERPT =
            "Packwright capture resource diagnostics clean";
    private static final String WORLD_READY_EXCERPT =
            "Packwright capture disposable world ready";
    private static final String WORLD_SETTINGS_EXCERPT =
            "Packwright capture world settings: seed=0; position=0.5,80,0.5; clock=6000; weather=clear; advance_time=false; advance_weather=false; spawn_mobs=false; random_tick_speed=0";
    private static final int SETTLE_FRAMES = 3;
    private static final int WORLD_EQUIP_TICKS = 12;
    private static final int GUI_SETTLE_TICKS = 2;
    private static final int MAX_RUNTIME_TICKS = 36_000;
    private static final int MAX_WORLD_LOAD_TICKS = 6_000;
    private static final long MAX_SCREENSHOT_BYTES = 8L * 1024 * 1024;
    private static final long MAX_LOG_BYTES = 16L * 1024 * 1024;
    private static final long MAX_PACK_BYTES = 512L * 1024 * 1024;

    private final CapturePaths paths;
    private final CapturePlan plan;
    private final String planFileSha256;
    private final List<CapturedScene> captures = new ArrayList<>();
    private final Object asyncLock = new Object();

    private State state = State.WAITING_FOR_WORLD;
    private int elapsedTicks;
    private int sceneIndex;
    private int equipTicksRemaining;
    private int animationTicksRemaining;
    private int animationTargetTick = -1;
    private int renderedSettleFrames;
    private int targetResizeAttempts;
    private ItemStack itemStack;
    private CompletableFuture<Void> reloadFuture;
    private CompletableFuture<Void> worldSetupFuture;
    private CompletableFuture<Void> sceneServerSetupFuture;
    private CompletableFuture<Void> animationServerSetupFuture;
    private List<String> selectedPackIds = List.of();
    private AsyncCapture asyncCapture;
    private PlayerModelType playerModelOverride;
    private boolean stopRequested;
    private boolean environmentVerified;
    private int worldCreationStartedTick;
    private int resourceReloadCompletedTick;
    private final RenderFrameEvidence renderFrameEvidence = new RenderFrameEvidence();
    private boolean renderPredicatesLogged;

    CaptureCoordinator(CapturePaths paths, CapturePlan plan, String planFileSha256) {
        this.paths = paths;
        this.plan = plan;
        this.planFileSha256 = planFileSha256;
    }

    void onClientTick(Minecraft client) {
        if (stopRequested) {
            client.stop();
            return;
        }
        try {
            elapsedTicks++;
            if (elapsedTicks > MAX_RUNTIME_TICKS) {
                fail(client, "timed_out", "Capture exceeded its internal runtime limit.");
                return;
            }
            switch (state) {
                case WAITING_FOR_WORLD -> waitForWorld(client);
                case CREATING_WORLD -> pollWorldCreation(client);
                case CONFIGURING_WORLD -> pollWorldSetup(client);
                case RELOADING_RESOURCES -> pollResourceReload(client);
                case WAITING_FOR_RELOAD_OVERLAY -> pollResourceReloadOverlay(client);
                case PREPARING_SCENE -> prepareScene(client);
                case WAITING_FOR_EQUIP -> waitForEquip(client);
                case WAITING_FOR_ANIMATION -> waitForAnimation(client);
                case WAITING_FOR_FRAMES -> { /* advanced by the render hook */ }
                case CAPTURING -> pollScreenshot(client);
                case FINALIZING -> finish(client);
                case DONE, FAILED -> stopRequested = true;
            }
        } catch (Exception error) {
            fail(client, failureCode(), CaptureRuntime.boundedMessage(error));
        }
    }

    void onRenderFrameStarted() {
        if (state == State.WAITING_FOR_FRAMES) {
            renderFrameEvidence.beginFrame();
        } else {
            renderFrameEvidence.abandonFrame();
        }
    }

    void onRenderedFrame(Minecraft client, boolean renderLevel) {
        if (state != State.WAITING_FOR_FRAMES) {
            renderFrameEvidence.abandonFrame();
            return;
        }
        RenderFrameAttestation frame;
        try {
            frame = renderFrameEvidence.finishFrame();
        } catch (IllegalStateException error) {
            fail(client, "scene_capture_failed", error.getMessage());
            return;
        }
        Scene scene = currentScene();
        if (scene.animationState() != AnimationState.IDLE && elapsedTicks != animationTargetTick) {
            fail(
                    client,
                    "scene_capture_failed",
                    "Minecraft did not render the requested animation frame before the next client tick.");
            return;
        }
        if (scene.context() == Context.WORLD) {
            var renderState = client.gameRenderer.gameRenderState();
            var cameraState = renderState.levelRenderState.cameraRenderState;
            LocalPlayer player = requirePlayer(client);
            InteractionHand expectedHand = scene.hand() == Hand.RIGHT
                    ? InteractionHand.MAIN_HAND
                    : InteractionHand.OFF_HAND;
            if ((scene.animationState() == AnimationState.USE
                            || scene.animationState() == AnimationState.FIRE
                            || scene.animationState() == AnimationState.AIM)
                    && (!player.isUsingItem()
                            || player.getUsedItemHand() != expectedHand
                            || player.getTicksUsingItem() < scene.frame())) {
                fail(client, "scene_capture_failed", "Minecraft did not render the requested active-use tick state.");
                return;
            }
            if ((scene.animationState() == AnimationState.SWING
                            || scene.animationState() == AnimationState.IMPACT)
                    && (!player.swinging
                            || player.swingingArm != expectedHand
                            || player.getAttackAnim(1.0f) <= 0.0f)) {
                fail(client, "scene_capture_failed", "Minecraft did not render the requested swing tick state.");
                return;
            }
            if (!renderPredicatesLogged) {
                renderPredicatesLogged = true;
                LOGGER.info(
                        "Packwright capture render predicates; id={}; viewKind={}; requiredForAuthority={}; renderLevel={}; camera={}; panoramic={}; sleeping={}; hudHidden={}; mode={}; animation={}; usingItem={}; usedHand={}; useTicks={}; attackAnim={}; vanillaHandsSubmitted={}; submittedItemMatched={}; oppositeHandEmpty={}; vanillaItemRendered={}; referenceArmRequested={}; referenceArmSubmissions={}; referenceArmMatched={}; unexpectedReferenceArmSubmission={}",
                        scene.id(),
                        scene.viewKind(),
                        scene.requiredForAuthority(),
                        renderLevel,
                        renderState.optionsRenderState.cameraType,
                        cameraState.isPanoramicMode,
                        cameraState.entityRenderState.isSleeping,
                        renderState.guiRenderState.isHudHidden,
                        client.gameMode == null ? "unavailable" : client.gameMode.getPlayerMode(),
                        scene.animationState(),
                        player.isUsingItem(),
                        player.getUsedItemHand(),
                        player.getTicksUsingItem(),
                        player.getAttackAnim(1.0f),
                        frame.vanillaHandSubmissionSeen(),
                        frame.submittedItemMatched(),
                        frame.oppositeHandEmpty(),
                        frame.vanillaItemRenderSeen(),
                        scene.referenceArm(),
                        frame.referenceArmSubmissionCount(),
                        frame.referenceArmSubmissionSeen(),
                        frame.unexpectedReferenceArmSubmissionSeen());
            }
            if (!renderLevel) {
                fail(client, "scene_capture_failed", "Minecraft did not render the world for a world capture scene.");
                return;
            }
            if (scene.camera() == Camera.FIRST_PERSON
                    && (renderState.optionsRenderState.cameraType != CameraType.FIRST_PERSON
                            || cameraState.isPanoramicMode
                            || cameraState.entityRenderState.isSleeping
                            || renderState.guiRenderState.isHudHidden
                            || client.gameMode == null
                            || client.gameMode.getPlayerMode() == GameType.SPECTATOR)) {
                fail(client, "scene_capture_failed", "Minecraft rejected the required first-person hand-render predicates.");
                return;
            }
            if (scene.camera() == Camera.FIRST_PERSON
                    && (!frame.vanillaHandSubmissionSeen()
                            || !frame.submittedItemMatched()
                            || !frame.oppositeHandEmpty()
                            || !frame.vanillaItemRenderSeen())) {
                fail(client, "scene_capture_failed", "Minecraft did not submit the exact planned held item.");
                return;
            }
            String referenceArmFailure = referenceArmEvidenceFailure(
                    scene.referenceArm(),
                    frame.referenceArmSubmissionCount(),
                    frame.referenceArmSubmissionSeen(),
                    frame.unexpectedReferenceArmSubmissionSeen());
            if (referenceArmFailure != null) {
                fail(client, "scene_capture_failed", referenceArmFailure);
                return;
            }
        } else if (scene.context() == Context.TOOLTIP) {
            ItemStack expected = itemForScene(scene);
            if (!(client.gui.screen() instanceof ItemInspectionScreen inspection)
                    || !inspection.submittedExactItem(expected, true)) {
                fail(client, "scene_capture_failed", "Minecraft did not submit the exact planned item and tooltip.");
                return;
            }
        } else if (scene.context() == Context.ITEM_INSPECTION) {
            ItemStack expected = itemForScene(scene);
            if (!(client.gui.screen() instanceof ItemInspectionScreen inspection)
                    || !inspection.submittedExactItem(expected, false)) {
                fail(client, "scene_capture_failed", "Minecraft did not submit the exact planned inspection item.");
                return;
            }
        } else if (scene.context() == Context.INVENTORY) {
            ItemStack expected = itemForScene(scene);
            ItemStack actual = requirePlayer(client).getInventory().getItem(0);
            if (!exactStack(actual, expected)) {
                fail(client, "scene_capture_failed", "The native inventory no longer contained the exact planned stack.");
                return;
            }
            if (!(client.gui.screen() instanceof AbstractContainerScreen<?> container)) {
                fail(client, "scene_capture_failed", "Minecraft did not render a native inventory container.");
                return;
            }
            var hovered = ((AbstractContainerScreenAccessor) container)
                    .packwrightCapture$getHoveredSlot();
            if (hovered != null) {
                fail(client, "scene_capture_failed", "A non-tooltip inventory scene hovered an unrelated slot.");
                return;
            }
            if (!renderPredicatesLogged) {
                renderPredicatesLogged = true;
                LOGGER.info(
                        "Packwright capture GUI predicates; id={}; context={}; mouseX={}; mouseY={}; hoveredSlot=none",
                        scene.id(),
                        scene.context(),
                        client.mouseHandler.getScaledXPos(client.getWindow()),
                        client.mouseHandler.getScaledYPos(client.getWindow()));
            }
        } else if (scene.context() == Context.HOTBAR) {
            LocalPlayer player = requirePlayer(client);
            boolean selected = scene.presentationFlag("selectedHotbar", false);
            int itemSlot = selected ? 0 : 1;
            if (player.getInventory().getSelectedSlot() != 0
                    || !exactStack(player.getInventory().getItem(itemSlot), itemForScene(scene))) {
                fail(client, "scene_capture_failed", "The native hotbar no longer contained the exact planned stack/selection.");
                return;
            }
            if (!renderPredicatesLogged) {
                renderPredicatesLogged = true;
                LOGGER.info(
                        "Packwright capture GUI predicates; id={}; context={}; exactStack=true; selectedSlot=0; itemSlot={}",
                        scene.id(),
                        scene.context(),
                        itemSlot);
            }
        }
        var target = client.gameRenderer.mainRenderTarget();
        if (target.width != scene.width() || target.height != scene.height()) {
            targetResizeAttempts++;
            if (targetResizeAttempts == 1) {
                Window window = client.getWindow();
                LOGGER.info(
                        "Waiting for exact capture framebuffer {}x{}; target={}x{}, window framebuffer={}x{}, window logical={}x{}",
                        scene.width(),
                        scene.height(),
                        target.width,
                        target.height,
                        window.getWidth(),
                        window.getHeight(),
                        window.getScreenWidth(),
                        window.getScreenHeight());
            }
            if (targetResizeAttempts > 120) {
                fail(client, "scene_capture_failed", "Minecraft framebuffer did not settle at the requested dimensions.");
                return;
            }
            client.gameRenderer.resize(scene.width(), scene.height());
            renderedSettleFrames = 0;
            return;
        }
        renderedSettleFrames++;
        if (renderedSettleFrames < SETTLE_FRAMES) return;
        state = State.CAPTURING;
        beginScreenshot(client, scene);
    }

    void onVanillaHandSubmission(
            LocalPlayer player, ItemStack submittedMain, ItemStack submittedOff) {
        if (!isCandidateWorldFrameOpen()) return;
        Scene scene = currentScene();
        ItemStack submitted = scene.hand() == Hand.RIGHT ? submittedMain : submittedOff;
        ItemStack opposite = scene.hand() == Hand.RIGHT ? submittedOff : submittedMain;
        ItemStack expected = itemForScene(scene);
        renderFrameEvidence.observeVanillaHand(
                submitted.getCount() == expected.getCount()
                        && ItemStack.isSameItemSameComponents(submitted, expected),
                opposite.isEmpty());
    }

    HumanoidArm referenceArm() {
        if (!isCandidateWorldFrameOpen()) return null;
        Scene scene = currentScene();
        if (scene.camera() != Camera.FIRST_PERSON || !scene.referenceArm()) return null;
        return scene.hand() == Hand.RIGHT ? HumanoidArm.RIGHT : HumanoidArm.LEFT;
    }

    void onReferenceArmSubmission(HumanoidArm arm) {
        if (!isCandidateWorldFrameOpen()) return;
        HumanoidArm expected = referenceArm();
        renderFrameEvidence.observeReferenceArm(expected != null && expected == arm);
    }

    static String referenceArmEvidenceFailure(
            boolean requested, int submissionCount, boolean matchingSeen, boolean unexpectedSeen) {
        if (submissionCount < 0) {
            throw new IllegalArgumentException("Reference-arm submission count cannot be negative.");
        }
        if (!requested && (submissionCount != 0 || matchingSeen || unexpectedSeen)) {
            return "A vanilla gameplay capture received an unexpected reference-arm augmentation.";
        }
        if (requested && submissionCount != 1) {
            return submissionCount == 0
                    ? "Minecraft did not submit the hash-bound reference-arm augmentation."
                    : "Minecraft submitted the hash-bound reference-arm augmentation more than once in one frame.";
        }
        if (requested && (!matchingSeen || unexpectedSeen)) {
            return "Minecraft did not submit the hash-bound reference-arm augmentation.";
        }
        return null;
    }

    void onVanillaItemRender(ItemStack rendered, net.minecraft.world.item.ItemDisplayContext context) {
        if (!isCandidateWorldFrameOpen()) return;
        Scene scene = currentScene();
        net.minecraft.world.item.ItemDisplayContext expectedContext = scene.hand() == Hand.RIGHT
                ? net.minecraft.world.item.ItemDisplayContext.FIRST_PERSON_RIGHT_HAND
                : net.minecraft.world.item.ItemDisplayContext.FIRST_PERSON_LEFT_HAND;
        ItemStack expected = itemForScene(scene);
        if (context == expectedContext
                && rendered.getCount() == expected.getCount()
                && ItemStack.isSameItemSameComponents(rendered, expected)) {
            renderFrameEvidence.observeVanillaItemRender();
        }
    }

    private boolean isCandidateWorldFrameOpen() {
        if (sceneIndex >= plan.scenes().size()) return false;
        if (currentScene().context() != Context.WORLD) return false;
        return state == State.WAITING_FOR_FRAMES && renderFrameEvidence.isOpen();
    }

    private static boolean exactStack(ItemStack actual, ItemStack expected) {
        return actual.getCount() == expected.getCount()
                && ItemStack.isSameItemSameComponents(actual, expected);
    }

    PlayerModelType playerModelOverride() {
        return playerModelOverride;
    }

    private void waitForWorld(Minecraft client) throws Exception {
        if (!environmentVerified) verifyEnvironment(client);
        if (client.level != null && client.player != null && client.isGameLoadFinished()) {
            beginWorldSetup(client);
            return;
        }
        beginWorldCreation(client);
    }

    private void verifyEnvironment(Minecraft client) throws Exception {
        if (!client.isOfflineDeveloperMode()) {
            throw new IllegalStateException("Capture client must run with --offlineDeveloperMode.");
        }
        if (!client.getLaunchedVersion().equals(plan.minecraftVersion())) {
            throw new IllegalStateException("Launched Minecraft version does not match the capture plan.");
        }
        String loaderVersion = FabricLoader.getInstance()
                .getModContainer("fabricloader")
                .orElseThrow(() -> new IllegalStateException("Fabric Loader metadata is unavailable."))
                .getMetadata()
                .getVersion()
                .getFriendlyString();
        if (!loaderVersion.equals("0.19.3")) {
            throw new IllegalStateException("Fabric Loader must be exactly 0.19.3.");
        }
        verifyStagedPacks();
        environmentVerified = true;
    }

    private void verifyStagedPacks() throws IOException {
        Path game = Path.of(plan.execution().gameDirectory());
        verifyStagedPack(
                game.resolve("resourcepacks/packwright-proposal.zip"),
                plan.provenance().resourcepackContentSha256(),
                "resource pack");
        verifyStagedPack(
                game.resolve("saves/packwright-capture/datapacks/packwright-proposal.zip"),
                plan.provenance().datapackContentSha256(),
                "datapack");
    }

    private static void verifyStagedPack(Path path, String expectedSha256, String label)
            throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path)) {
            throw new IOException("Staged " + label + " is unavailable or unsafe.");
        }
        String actual = Hashing.sha256(path, MAX_PACK_BYTES);
        if (!actual.equals(expectedSha256)) {
            throw new IOException("Staged " + label + " does not match capture provenance.");
        }
    }

    private void beginWorldCreation(Minecraft client) throws IOException {
        if (state == State.CREATING_WORLD) return;
        Path level = Path.of(plan.execution().gameDirectory())
                .resolve("saves/packwright-capture/level.dat");
        if (Files.exists(level)) {
            throw new IOException("Disposable capture world was not clean before creation.");
        }
        state = State.CREATING_WORLD;
        worldCreationStartedTick = elapsedTicks;
        LevelSettings settings = new LevelSettings(
                "Packwright Capture",
                GameType.CREATIVE,
                new LevelSettings.DifficultySettings(Difficulty.PEACEFUL, false, true),
                true,
                WorldDataConfiguration.DEFAULT);
        LOGGER.info("Creating deterministic disposable Packwright capture world");
        client.createWorldOpenFlows().createFreshLevel(
                "packwright-capture",
                settings,
                new WorldOptions(0L, false, false),
                WorldPresets::createTestWorldDimensions,
                null);
    }

    private void pollWorldCreation(Minecraft client) {
        if (client.level != null && client.player != null && client.isGameLoadFinished()) {
            beginWorldSetup(client);
            return;
        }
        if (elapsedTicks - worldCreationStartedTick > MAX_WORLD_LOAD_TICKS) {
            throw new IllegalStateException("Disposable Minecraft world did not finish loading.");
        }
    }

    private void beginWorldSetup(Minecraft client) {
        MinecraftServer server = client.getSingleplayerServer();
        if (server == null || client.player == null) {
            throw new IllegalStateException("Loaded capture world has no integrated server or player.");
        }
        List<String> datapacks = server.getPackRepository().getSelectedIds().stream().sorted().toList();
        if (!datapacks.contains(REQUIRED_RESOURCE_PACK)) {
            throw new IllegalStateException("Staged Packwright datapack was not selected at world creation.");
        }
        var playerId = client.player.getUUID();
        worldSetupFuture = server.submit(() -> configureWorld(server, playerId));
        state = State.CONFIGURING_WORLD;
        LOGGER.info("Configuring disposable Packwright capture world; selected datapacks={}", datapacks);
    }

    private static void configureWorld(MinecraftServer server, java.util.UUID playerId) {
        ServerLevel level = server.overworld();
        ServerLevelData levelData = (ServerLevelData) level.getLevelData();
        levelData.setGameTime(0L);
        var rules = level.getGameRules();
        rules.set(GameRules.ADVANCE_TIME, false, server);
        rules.set(GameRules.ADVANCE_WEATHER, false, server);
        rules.set(GameRules.SPAWN_MOBS, false, server);
        rules.set(GameRules.SPAWN_MONSTERS, false, server);
        rules.set(GameRules.RANDOM_TICK_SPEED, 0, server);
        level.dimensionType().defaultClock().ifPresentOrElse(clock -> {
            server.clockManager().setTotalTicks(clock, 6_000L);
            server.clockManager().setPaused(clock, true);
        }, () -> {
            throw new IllegalStateException("Capture overworld has no default clock.");
        });
        WeatherData weather = level.getWeatherData();
        weather.setClearWeatherTime(Integer.MAX_VALUE);
        weather.setRainTime(0);
        weather.setThunderTime(0);
        weather.setRaining(false);
        weather.setThundering(false);
        level.setRainLevel(0);
        level.setThunderLevel(0);
        ServerPlayer player = server.getPlayerList().getPlayer(playerId);
        if (player == null) throw new IllegalStateException("Integrated-server capture player is unavailable.");
        player.teleportTo(level, 0.5, 80, 0.5, Set.of(), 0, 0, true);
        player.setNoGravity(true);
        player.setDeltaMovement(0, 0, 0);
        player.setYRot(0);
        player.setXRot(0);
        player.setYHeadRot(0);
        player.setYBodyRot(0);
        player.setOldRot();
        if (level.getDefaultClockTime() != 6_000L
                || rules.get(GameRules.ADVANCE_TIME)
                || rules.get(GameRules.ADVANCE_WEATHER)
                || rules.get(GameRules.SPAWN_MOBS)
                || rules.get(GameRules.SPAWN_MONSTERS)
                || rules.get(GameRules.RANDOM_TICK_SPEED) != 0) {
            throw new IllegalStateException("Disposable world settings did not become deterministic.");
        }
    }

    private void pollWorldSetup(Minecraft client) throws Exception {
        if (worldSetupFuture == null || !worldSetupFuture.isDone()) return;
        worldSetupFuture.join();
        Path level = Path.of(plan.execution().gameDirectory())
                .resolve("saves/packwright-capture/level.dat");
        if (Files.isSymbolicLink(level) || !Files.isRegularFile(level)) {
            throw new IllegalStateException("Disposable world has no safe level.dat after creation.");
        }
        LOGGER.info(WORLD_READY_EXCERPT);
        LOGGER.info(WORLD_SETTINGS_EXCERPT);
        beginResourceReload(client);
    }

    private void beginResourceReload(Minecraft client) throws Exception {
        Files.createDirectory(paths.outputDirectory().resolve("screenshots"));
        PackRepository repository = client.getResourcePackRepository();
        repository.reload();
        if (!repository.isAvailable(REQUIRED_RESOURCE_PACK)) {
            throw new IllegalStateException(
                    "Staged Packwright resource pack is unavailable: " + REQUIRED_RESOURCE_PACK);
        }
        List<String> selected = new ArrayList<>(repository.getSelectedIds());
        if (!selected.contains(REQUIRED_RESOURCE_PACK)) selected.add(REQUIRED_RESOURCE_PACK);
        repository.setSelected(selected);
        if (!repository.getSelectedIds().contains(REQUIRED_RESOURCE_PACK)) {
            throw new IllegalStateException("Minecraft rejected the staged resource-pack selection.");
        }
        client.options.updateResourcePacks(repository);
        selectedPackIds = repository.getSelectedIds().stream().sorted().toList();
        // The diagnostic boundary must precede the asynchronous reload call.
        // Resource workers can log model/texture failures immediately; logging
        // this marker afterward would let those failures race ahead of the
        // segment that currentResourceReloadFailure() classifies.
        LOGGER.info("{}; selected packs={}", RESOURCE_RELOAD_STARTED_EXCERPT, selectedPackIds);
        reloadFuture = client.reloadResourcePacks();
        state = State.RELOADING_RESOURCES;
    }

    private void pollResourceReload(Minecraft client) throws Exception {
        if (reloadFuture == null || !reloadFuture.isDone()) return;
        reloadFuture.join();
        resourceReloadCompletedTick = elapsedTicks;
        state = State.WAITING_FOR_RELOAD_OVERLAY;
    }

    private void pollResourceReloadOverlay(Minecraft client) throws Exception {
        if (client.gui.overlay() != null) {
            if (elapsedTicks - resourceReloadCompletedTick > 600) {
                throw new IllegalStateException(
                        "Minecraft resource-reload overlay did not finish before capture.");
            }
            return;
        }
        String resourceFailure = currentResourceReloadFailure();
        if (resourceFailure != null) {
            throw new IllegalStateException(
                    "Minecraft logged a resource/model/texture load failure: " + resourceFailure);
        }
        itemStack = parseItem(client);
        state = State.PREPARING_SCENE;
        LOGGER.info(RESOURCE_DIAGNOSTICS_EXCERPT);
        LOGGER.info("{}; selected packs={}", RESOURCE_RELOAD_EXCERPT, selectedPackIds);
    }

    private String currentResourceReloadFailure() throws IOException {
        Path source = Path.of(plan.execution().gameDirectory()).resolve("logs/latest.log");
        if (Files.isSymbolicLink(source) || !Files.isRegularFile(source)) {
            throw new IOException("Minecraft client log is unavailable during resource verification.");
        }
        long size = Files.size(source);
        if (size <= 0 || size > MAX_LOG_BYTES) {
            throw new IOException("Minecraft client log exceeds its resource-verification budget.");
        }
        byte[] bytes = Files.readAllBytes(source);
        if (bytes.length != size || bytes.length > MAX_LOG_BYTES) {
            throw new IOException("Minecraft client log changed during resource verification.");
        }
        return resourceReloadFailure(new String(bytes, StandardCharsets.UTF_8));
    }

    static String resourceReloadFailure(String text) {
        int start = text.lastIndexOf(RESOURCE_RELOAD_STARTED_EXCERPT);
        if (start < 0) return "resource-reload start marker is missing";
        String segment = text.substring(start);
        for (String line : segment.split("\\R")) {
            String lower = line.toLowerCase(Locale.ROOT);
            boolean loggedError = lower.contains("/error]:");
            boolean loggedWarning = lower.contains("/warn]:");
            boolean resourceSubject = lower.contains("model")
                    || lower.contains("texture")
                    || lower.contains("blockstate")
                    || lower.contains("item definition")
                    || lower.contains("atlas")
                    || lower.contains("sprite");
            boolean failureWording = lower.contains("missing")
                    || lower.contains("unable")
                    || lower.contains("failed")
                    || lower.contains("could not")
                    || lower.contains("couldn't")
                    || lower.contains("not found")
                    || lower.contains("unresolved")
                    || lower.contains("invalid")
                    || lower.contains("exception");
            if (loggedError || (loggedWarning && resourceSubject && failureWording)) {
                String cleaned = line.replace('\r', ' ').replace('\n', ' ').trim();
                if (cleaned.isEmpty()) cleaned = "unclassified resource load error";
                return cleaned.length() <= 384 ? cleaned : cleaned.substring(0, 384);
            }
        }
        return null;
    }

    private ItemStack parseItem(Minecraft client) throws Exception {
        if (client.level == null) throw new IllegalStateException("Client level disappeared during item parsing.");
        CapturePlan.ItemStackSpec planned = plan.provenance().itemStack();
        String prefix = "give @s ";
        String suffix = " " + planned.count();
        String command = planned.command();
        if (!command.startsWith(prefix)
                || !command.endsWith(suffix)
                || command.length() <= prefix.length() + suffix.length()) {
            throw new IllegalStateException("Item command must be the exact bounded 'give @s <item> <count>' form.");
        }
        String itemSyntax = command.substring(prefix.length(), command.length() - suffix.length());
        StringReader reader = new StringReader(itemSyntax);
        ItemInput input = new ItemParser(client.level.registryAccess()).parse(reader);
        if (reader.canRead()) {
            throw new IllegalStateException("Item syntax contains trailing input at cursor " + reader.getCursor() + '.');
        }
        ItemStack parsed = input.createItemStack(planned.count());
        String actualItemId = BuiltInRegistries.ITEM.getKey(parsed.getItem()).toString();
        if (!actualItemId.equals(planned.itemId())) {
            throw new IllegalStateException("Parsed item id does not match capture provenance.");
        }
        String componentSyntax = planned.components().entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> entry.getKey() + '=' + entry.getValue())
                .collect(java.util.stream.Collectors.joining(","));
        String declaredSyntax = planned.itemId()
                + (componentSyntax.isEmpty() ? "" : '[' + componentSyntax + ']');
        StringReader declaredReader = new StringReader(declaredSyntax);
        ItemInput declaredInput = new ItemParser(client.level.registryAccess()).parse(declaredReader);
        if (declaredReader.canRead()) {
            throw new IllegalStateException(
                    "Declared item components contain trailing input at cursor "
                            + declaredReader.getCursor() + '.');
        }
        ItemStack declared = declaredInput.createItemStack(planned.count());
        if (!ItemStack.isSameItemSameComponents(parsed, declared)) {
            throw new IllegalStateException(
                    "Parsed item components do not match the separately hash-bound component map.");
        }
        return parsed;
    }

    private void prepareScene(Minecraft client) {
        LocalPlayer player = requirePlayer(client);
        Scene scene = currentScene();
        renderedSettleFrames = 0;
        targetResizeAttempts = 0;
        renderFrameEvidence.abandonFrame();
        renderPredicatesLogged = false;
        animationTargetTick = -1;
        sceneServerSetupFuture = null;
        animationServerSetupFuture = null;
        resize(client, scene.width(), scene.height());
        player.stopUsingItem();
        player.swinging = false;
        player.swingingArm = null;
        player.swingTime = 0;
        player.oAttackAnim = 0.0F;
        player.attackAnim = 0.0F;
        client.gui.toastManager().clear();
        // Drive held-use through Minecraft's own key/action loop. Without a
        // held use mapping, the client releases an item on the next tick even
        // after a successful gameMode.useItem() call.
        client.options.keyUse.setDown(false);
        player.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
        player.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
        player.getInventory().setItem(0, ItemStack.EMPTY);
        player.getInventory().setItem(1, ItemStack.EMPTY);

        ItemStack sceneStack = itemForScene(scene);
        if (scene.context() == Context.WORLD) {
            prepareWorldScene(client, player, scene, sceneStack);
        } else {
            prepareGuiScene(client, player, scene, sceneStack);
        }
        equipTicksRemaining = scene.context() == Context.WORLD
                ? WORLD_EQUIP_TICKS
                : GUI_SETTLE_TICKS;
        state = State.WAITING_FOR_EQUIP;
    }

    private ItemStack itemForScene(Scene scene) {
        ItemStack result = itemStack.copyWithCount(scene.stackCount(plan.provenance().itemStack().count()));
        if (scene.presentation() != null && scene.presentation().containsKey("showGlint")) {
            result.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, scene.presentationFlag("showGlint", false));
        }
        Double durability = scene.durabilityFraction();
        if (durability != null) {
            result.set(DataComponents.MAX_STACK_SIZE, 1);
            result.set(DataComponents.MAX_DAMAGE, 100);
            result.set(DataComponents.DAMAGE, (int) Math.round((1.0 - durability) * 100.0));
            result.setCount(1);
        }
        return result;
    }

    private void prepareWorldScene(
            Minecraft client, LocalPlayer player, Scene scene, ItemStack sceneStack) {
        client.setScreenAndShow(null);
        if (client.gui.hud.isHidden()) client.gui.hud.toggle();
        client.gameRenderer.mainCamera().disablePanoramicMode();
        client.options.fov().set(scene.fov());
        client.options.guiScale().set(scene.guiScale());
        client.options.mainHand().set(HumanoidArm.RIGHT);
        client.options.setCameraType(switch (scene.camera()) {
            case FIRST_PERSON, NEUTRAL -> CameraType.FIRST_PERSON;
            case THIRD_PERSON_BACK -> CameraType.THIRD_PERSON_BACK;
            case THIRD_PERSON_FRONT -> CameraType.THIRD_PERSON_FRONT;
        });
        playerModelOverride = scene.playerModel() == PlayerModel.STEVE
                ? PlayerModelType.WIDE
                : PlayerModelType.SLIM;
        player.setYRot(0);
        player.setXRot(0);
        player.setYHeadRot(0);
        float bodyYaw = scene.camera() == Camera.FIRST_PERSON ? 0 : 35;
        if (scene.id().contains("left")) bodyYaw = -bodyYaw;
        player.setYBodyRot(bodyYaw);
        player.setOldRot();
        InteractionHand hand = scene.hand() == Hand.RIGHT
                ? InteractionHand.MAIN_HAND
                : InteractionHand.OFF_HAND;
        synchronizeServerHeldItem(client, player, hand, sceneStack);
        player.setItemInHand(hand, sceneStack);
        synchronizeVanillaHandRenderer(client, player);
    }

    private void synchronizeServerHeldItem(
            Minecraft client, LocalPlayer player, InteractionHand hand, ItemStack sceneStack) {
        MinecraftServer server = client.getSingleplayerServer();
        if (server == null) {
            throw new IllegalStateException("Integrated server disappeared during scene setup.");
        }
        java.util.UUID playerId = player.getUUID();
        ItemStack serverStack = sceneStack.copy();
        sceneServerSetupFuture = server.submit(() -> {
            ServerPlayer serverPlayer = server.getPlayerList().getPlayer(playerId);
            if (serverPlayer == null) {
                throw new IllegalStateException("Integrated-server capture player is unavailable.");
            }
            serverPlayer.getInventory().setSelectedSlot(0);
            serverPlayer.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
            serverPlayer.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
            serverPlayer.setItemInHand(hand, serverStack);
            serverPlayer.containerMenu.broadcastChanges();
        });
    }

    private static void synchronizeVanillaHandRenderer(Minecraft client, LocalPlayer player) {
        ItemInHandRendererAccessor renderer =
                (ItemInHandRendererAccessor) (Object) client.gameRenderer.itemInHandRenderer;
        renderer.packwrightCapture$setMainHandItem(player.getMainHandItem());
        renderer.packwrightCapture$setOffHandItem(player.getOffhandItem());
        renderer.packwrightCapture$setMainHandHeight(1.0F);
        renderer.packwrightCapture$setPreviousMainHandHeight(1.0F);
        renderer.packwrightCapture$setOffHandHeight(1.0F);
        renderer.packwrightCapture$setPreviousOffHandHeight(1.0F);
    }

    private void waitForEquip(Minecraft client) {
        if (sceneServerSetupFuture != null) {
            if (!sceneServerSetupFuture.isDone()) return;
            sceneServerSetupFuture.join();
            sceneServerSetupFuture = null;
        }
        equipTicksRemaining--;
        if (equipTicksRemaining > 0) return;
        Scene scene = currentScene();
        if (scene.context() == Context.WORLD) {
            LocalPlayer player = requirePlayer(client);
            if (client.gameMode == null || client.gameMode.getPlayerMode() != GameType.CREATIVE) {
                throw new IllegalStateException("Capture client is not in creative mode.");
            }
            InteractionHand hand = scene.hand() == Hand.RIGHT
                    ? InteractionHand.MAIN_HAND
                    : InteractionHand.OFF_HAND;
            ItemStack expected = itemForScene(scene);
            ItemStack actual = player.getItemInHand(hand);
            if (actual.getCount() != expected.getCount()
                    || !ItemStack.isSameItemSameComponents(actual, expected)) {
                throw new IllegalStateException(
                        "Exact planned item stack did not survive integrated-server synchronization.");
            }
            synchronizeVanillaHandRenderer(client, player);
            client.gui.toastManager().clear();
            LOGGER.info(
                    "Packwright capture world scene ready; id={}; mode={}; handsBusy={}; mainHand={}; offHand={}",
                    scene.id(),
                    client.gameMode.getPlayerMode(),
                    player.isHandsBusy(),
                    BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()),
                    BuiltInRegistries.ITEM.getKey(player.getOffhandItem().getItem()));
            beginAnimation(client, player, scene);
        }
        animationTicksRemaining = scene.frame();
        if (animationServerSetupFuture != null || animationTicksRemaining > 0) {
            state = State.WAITING_FOR_ANIMATION;
        } else {
            prepareAnimationTarget(scene);
            state = State.WAITING_FOR_FRAMES;
        }
    }

    private void beginAnimation(Minecraft client, LocalPlayer player, Scene scene) {
        InteractionHand hand = scene.hand() == Hand.RIGHT
                ? InteractionHand.MAIN_HAND
                : InteractionHand.OFF_HAND;
        switch (scene.animationState()) {
            case SWING, IMPACT -> {
                player.swing(hand, true);
                if (!player.swinging || player.swingingArm != hand) {
                    throw new IllegalStateException("Minecraft rejected the requested swing animation.");
                }
            }
            case USE, FIRE, AIM, RELEASE -> {
                client.options.keyUse.setDown(true);
                if (client.gameMode == null
                        || !client.gameMode.useItem(player, hand).consumesAction()
                        || !player.isUsingItem()
                        || player.getUsedItemHand() != hand) {
                    throw new IllegalStateException(
                            "The exact planned item does not support the requested active-use animation.");
                }
                MinecraftServer server = client.getSingleplayerServer();
                if (server == null) {
                    throw new IllegalStateException(
                            "Integrated server disappeared during animation setup.");
                }
                java.util.UUID playerId = player.getUUID();
                animationServerSetupFuture = server.submit(() -> {
                    ServerPlayer serverPlayer = server.getPlayerList().getPlayer(playerId);
                    if (serverPlayer == null) {
                        throw new IllegalStateException(
                                "Integrated-server capture player is unavailable.");
                    }
                    serverPlayer.startUsingItem(hand);
                    if (!serverPlayer.isUsingItem() || serverPlayer.getUsedItemHand() != hand) {
                        throw new IllegalStateException(
                                "Integrated server rejected the requested active-use animation.");
                    }
                });
            }
            case IDLE -> { }
        }
    }

    private void prepareGuiScene(
            Minecraft client, LocalPlayer player, Scene scene, ItemStack sceneStack) {
        playerModelOverride = null;
        client.options.setCameraType(CameraType.FIRST_PERSON);
        client.options.guiScale().set(scene.guiScale());
        client.resizeGui();
        if (client.gui.hud.isHidden()) client.gui.hud.toggle();
        parkCursor(client);

        if (scene.context() == Context.HOTBAR) {
            boolean selected = scene.presentationFlag("selectedHotbar", false);
            int itemSlot = selected ? 0 : 1;
            player.getInventory().setItem(itemSlot, sceneStack);
            player.getInventory().setSelectedSlot(0);
            client.setScreenAndShow(null);
            return;
        }

        if (scene.context() == Context.ITEM_INSPECTION) {
            client.setScreenAndShow(new ItemInspectionScreen(sceneStack));
            return;
        }

        if (scene.context() == Context.TOOLTIP) {
            client.setScreenAndShow(new ItemInspectionScreen(sceneStack, true));
            return;
        }

        player.getInventory().setItem(0, sceneStack);
        player.getInventory().setSelectedSlot(0);
        client.setScreenAndShow(new InventoryScreen(player));
        parkCursor(client);
    }

    private static void parkCursor(Minecraft client) {
        // GLFW cursor coordinates are window coordinates, not framebuffer
        // pixels. Keep non-tooltip review scenes away from all interactive
        // slots; the tooltip scene uses an exact-stack native tooltip screen.
        GLFW.glfwSetCursorPos(client.getWindow().handle(), -1_000.0, -1_000.0);
        MouseHandlerAccessor accessor = (MouseHandlerAccessor) client.mouseHandler;
        accessor.packwrightCapture$setX(-1_000.0);
        accessor.packwrightCapture$setY(-1_000.0);
    }

    private void waitForAnimation(Minecraft client) {
        LocalPlayer player = requirePlayer(client);
        if (animationServerSetupFuture != null) {
            if (!animationServerSetupFuture.isDone()) return;
            animationServerSetupFuture.join();
            animationServerSetupFuture = null;
            Scene scene = currentScene();
            InteractionHand hand = scene.hand() == Hand.RIGHT
                    ? InteractionHand.MAIN_HAND
                    : InteractionHand.OFF_HAND;
            // Align local prediction to the server-authored deterministic scene
            // after the server task has committed, then start counting frames.
            player.startUsingItem(hand);
            if (!player.isUsingItem() || player.getUsedItemHand() != hand) {
                throw new IllegalStateException(
                        "Client rejected the server-synchronized active-use animation.");
            }
            if (animationTicksRemaining == 0) {
                prepareAnimationTarget(scene);
                state = State.WAITING_FOR_FRAMES;
            }
            return;
        }
        animationTicksRemaining--;
        if (animationTicksRemaining > 0) return;
        Scene scene = currentScene();
        InteractionHand hand = scene.hand() == Hand.RIGHT
                ? InteractionHand.MAIN_HAND
                : InteractionHand.OFF_HAND;
        switch (scene.animationState()) {
            case SWING, IMPACT -> {
                if (!player.swinging || player.swingingArm != hand) {
                    throw new IllegalStateException(
                            "The requested swing animation ended before its capture frame.");
                }
            }
            case USE, FIRE, AIM -> {
                if (!player.isUsingItem() || player.getUsedItemHand() != hand) {
                    throw new IllegalStateException(
                            "The requested active-use animation for scene '"
                                    + scene.id()
                                    + "' ended before its capture frame.");
                }
            }
            case RELEASE -> {
                client.options.keyUse.setDown(false);
                if (client.gameMode == null) {
                    throw new IllegalStateException("Client interaction controller is unavailable.");
                }
                client.gameMode.releaseUsingItem(player);
                player.stopUsingItem();
            }
            case IDLE -> { }
        }
        prepareAnimationTarget(scene);
        state = State.WAITING_FOR_FRAMES;
    }

    private void prepareAnimationTarget(Scene scene) {
        if (scene.animationState() == AnimationState.IDLE) return;
        animationTargetTick = elapsedTicks;
        // Resize/equip settling happens before animation. Capture the first render
        // at the requested tick instead of advancing the pose by three more frames.
        renderedSettleFrames = SETTLE_FRAMES - 1;
    }

    private void resize(Minecraft client, int width, int height) {
        Window window = client.getWindow();
        if (window.isFullscreen()) window.toggleFullScreen();
        int logicalWidth = logicalWindowDimension(width, window.getWidth(), window.getScreenWidth());
        int logicalHeight = logicalWindowDimension(height, window.getHeight(), window.getScreenHeight());
        window.setWindowed(logicalWidth, logicalHeight);
        client.gameRenderer.resize(width, height);
        client.resizeGui();
    }

    private static int logicalWindowDimension(int requestedPixels, int framebuffer, int logical) {
        if (framebuffer <= 0 || logical <= 0) return requestedPixels;
        double pixelRatio = (double) framebuffer / logical;
        if (!Double.isFinite(pixelRatio) || pixelRatio < 0.5 || pixelRatio > 4.0) {
            return requestedPixels;
        }
        return Math.max(1, (int) Math.round(requestedPixels / pixelRatio));
    }

    private void beginScreenshot(Minecraft client, Scene scene) {
        String filename = scene.id() + ".png";
        String stagingName = ".pw-" + filename;
        Path screenshotDirectory = paths.outputDirectory().resolve("screenshots");
        Path staging = screenshotDirectory.resolve(stagingName);
        Path destination = screenshotDirectory.resolve(filename);
        try {
            if (Files.exists(staging) || Files.exists(destination)) {
                throw new IOException("Screenshot destination already exists.");
            }
            Screenshot.grab(
                    paths.outputDirectory().toFile(),
                    stagingName,
                    client.gameRenderer.mainRenderTarget(),
                    1,
                    message -> completeScreenshot(
                            scene, staging, destination, filename, message.getString()));
        } catch (Exception error) {
            synchronized (asyncLock) {
                asyncCapture = AsyncCapture.failed(CaptureRuntime.boundedMessage(error));
            }
        }
    }

    private void completeScreenshot(
            Scene scene,
            Path staging,
            Path destination,
            String filename,
            String minecraftMessage) {
        AsyncCapture result;
        try {
            if (!Files.isRegularFile(staging)) {
                throw new IOException("Minecraft screenshot failed: " + minecraftMessage);
            }
            PngEvidence evidence = PngEvidence.inspect(staging);
            if (evidence.width() != scene.width() || evidence.height() != scene.height()) {
                throw new IOException("Minecraft framebuffer dimensions changed during capture.");
            }
            AtomicFiles.moveNew(staging, destination);
            if (!Hashing.sha256(destination, MAX_SCREENSHOT_BYTES).equals(evidence.sha256())) {
                throw new IOException("Screenshot changed during atomic commit.");
            }
            result = AsyncCapture.completed(new CapturedScene(
                    scene,
                    filename,
                    evidence.width(),
                    evidence.height(),
                    evidence.size(),
                    evidence.sha256()));
        } catch (Exception error) {
            result = AsyncCapture.failed(CaptureRuntime.boundedMessage(error));
        }
        synchronized (asyncLock) {
            asyncCapture = result;
        }
    }

    private void pollScreenshot(Minecraft client) {
        AsyncCapture result;
        synchronized (asyncLock) {
            result = asyncCapture;
            asyncCapture = null;
        }
        if (result == null) return;
        if (result.error() != null) {
            fail(client, "scene_capture_failed", result.error());
            return;
        }
        captures.add(result.capture());
        client.options.keyUse.setDown(false);
        if (client.player != null) client.player.stopUsingItem();
        sceneIndex++;
        state = sceneIndex >= plan.scenes().size() ? State.FINALIZING : State.PREPARING_SCENE;
    }

    private void finish(Minecraft client) {
        try {
            LogEvidence log = copyClientLog();
            byte[] report = CanonicalJson.encode(successReport(client, log));
            writeReportAndSentinel(report);
            state = State.DONE;
            stopRequested = true;
            client.options.keyUse.setDown(false);
            LOGGER.info(
                    "Packwright capture execution {} completed with {} framebuffer PNGs",
                    plan.execution().executionId(),
                    captures.size());
        } catch (ResourceReloadEvidenceException error) {
            fail(client, "resource_reload_failed", CaptureRuntime.boundedMessage(error));
        } catch (Exception error) {
            fail(client, "internal_error", "Could not finalize capture evidence: "
                    + CaptureRuntime.boundedMessage(error));
        }
    }

    private LogEvidence copyClientLog() throws IOException {
        Path source = Path.of(plan.execution().gameDirectory()).resolve("logs/latest.log");
        if (Files.isSymbolicLink(source) || !Files.isRegularFile(source)) {
            throw new IOException("Minecraft client log is unavailable or unsafe.");
        }
        long sourceSize = Files.size(source);
        if (sourceSize <= 0 || sourceSize > MAX_LOG_BYTES) {
            throw new IOException("Minecraft client log exceeds its evidence byte budget.");
        }
        byte[] bytes = Files.readAllBytes(source);
        if (bytes.length != sourceSize || bytes.length > MAX_LOG_BYTES) {
            throw new IOException("Minecraft client log changed while being collected.");
        }
        String text = new String(bytes, StandardCharsets.UTF_8);
        if (!text.contains(RESOURCE_RELOAD_EXCERPT)) {
            throw new IOException("Minecraft client log has no successful resource-reload evidence.");
        }
        if (!text.contains(RESOURCE_DIAGNOSTICS_EXCERPT)) {
            throw new IOException("Minecraft client log has no clean resource-diagnostics evidence.");
        }
        String resourceFailure = resourceReloadFailure(text);
        if (resourceFailure != null) {
            throw new ResourceReloadEvidenceException(
                    "Minecraft logged a resource/model/texture load failure: " + resourceFailure);
        }
        Path directory = paths.outputDirectory().resolve("logs");
        Files.createDirectory(directory);
        Path destination = directory.resolve("client.log");
        AtomicFiles.writeNew(destination, bytes);
        if (!text.contains(WORLD_READY_EXCERPT)) {
            throw new IOException("Minecraft client log has no disposable-world readiness evidence.");
        }
        if (!text.contains(WORLD_SETTINGS_EXCERPT)) {
            throw new IOException("Minecraft client log has no deterministic-world settings evidence.");
        }
        return new LogEvidence(
                "logs/client.log",
                Hashing.sha256(bytes),
                bytes.length,
                List.of(
                        WORLD_READY_EXCERPT,
                        WORLD_SETTINGS_EXCERPT,
                        RESOURCE_DIAGNOSTICS_EXCERPT,
                        RESOURCE_RELOAD_EXCERPT));
    }

    private Map<String, Object> successReport(Minecraft client, LogEvidence log) {
        Map<String, Object> report = commonReport(client);
        report.put("status", "complete");
        report.put("views", captures.stream().map(CapturedScene::toReport).toList());
        report.put("log", log.toReport());
        return report;
    }

    private Map<String, Object> commonReport(Minecraft client) {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("schemaVersion", 2);
        report.put("kind", "packwright.client-capture-report");
        report.put("executionId", plan.execution().executionId());
        report.put("planSha256", plan.planSha256());
        report.put("identity", captureIdentity());
        report.put("runtime", runtime(client));
        return report;
    }

    private Map<String, Object> captureIdentity() {
        CapturePlan.Provenance provenance = plan.provenance();
        Map<String, Object> identity = new LinkedHashMap<>();
        identity.put("minecraftVersion", plan.minecraftVersion());
        identity.put("projectId", provenance.projectId());
        identity.put("runId", provenance.runId());
        identity.put("revisionId", provenance.revisionId());
        identity.put("specSha256", provenance.specSha256());
        identity.put("compiledArtifactId", provenance.compiledArtifactId());
        identity.put("proposalArtifactId", provenance.proposalArtifactId());
        identity.put("projectManifestSha256", provenance.projectManifestSha256());
        identity.put("runtimeManifestSha256", provenance.runtimeManifestSha256());
        identity.put("datapackContentSha256", provenance.datapackContentSha256());
        identity.put("resourcepackContentSha256", provenance.resourcepackContentSha256());
        identity.put(
                "itemStackSha256",
                Hashing.sha256(CanonicalJson.encode(provenance.itemStack().toProtocolValue())));
        identity.put("clientJarSha1", provenance.client().jarSha1());
        identity.put("clientJarSha256", provenance.client().jarSha256());
        identity.put("captureModId", provenance.captureMod().id());
        identity.put("captureModVersion", provenance.captureMod().version());
        identity.put("captureModSha256", provenance.captureMod().sha256());
        return identity;
    }

    private static Map<String, Object> runtime(Minecraft client) {
        DeviceInfo device = RenderSystem.getDevice().getDeviceInfo();
        String backendName = device.backendName().toLowerCase(Locale.ROOT);
        String backend = backendName.contains("vulkan") ? "vulkan" : "opengl";
        Map<String, Object> runtime = new LinkedHashMap<>();
        runtime.put("rendererBackend", backend);
        runtime.put("operatingSystem", boundedRuntimeField(
                System.getProperty("os.name") + " " + System.getProperty("os.version")));
        runtime.put("javaVersion", boundedRuntimeField(System.getProperty("java.version")));
        runtime.put("gpuVendor", boundedRuntimeField(device.vendorName()));
        runtime.put("gpuRenderer", boundedRuntimeField(device.name()));
        runtime.put("driverVersion", boundedRuntimeField(device.driverInfo()));
        return runtime;
    }

    private static String boundedRuntimeField(String value) {
        String cleaned = value == null ? "unknown" : value.replace('\r', ' ').replace('\n', ' ');
        if (cleaned.isBlank()) cleaned = "unknown";
        return cleaned.length() <= 512 ? cleaned : cleaned.substring(0, 512);
    }

    private void writeReportAndSentinel(byte[] report) throws IOException {
        Path reportPath = paths.outputDirectory().resolve("capture-report.json");
        AtomicFiles.writeNew(reportPath, report);
        Map<String, Object> reportReference = new LinkedHashMap<>();
        reportReference.put("path", "capture-report.json");
        reportReference.put("sha256", Hashing.sha256(report));
        reportReference.put("bytes", report.length);
        Map<String, Object> sentinel = new LinkedHashMap<>();
        sentinel.put("schemaVersion", 2);
        sentinel.put("kind", "packwright.client-capture-complete");
        sentinel.put("executionId", plan.execution().executionId());
        sentinel.put("planSha256", plan.planSha256());
        sentinel.put("report", reportReference);
        AtomicFiles.writeNew(
                paths.outputDirectory().resolve("capture-complete.json"),
                CanonicalJson.encode(sentinel));
    }

    private void fail(Minecraft client, String code, String message) {
        if (state == State.FAILED || state == State.DONE) return;
        state = State.FAILED;
        client.options.keyUse.setDown(false);
        String bounded = message.length() <= 512 ? message : message.substring(0, 512);
        LOGGER.error("Packwright capture failed: {}: {}", code, bounded);
        try {
            if (!Files.exists(paths.outputDirectory().resolve("capture-report.json"))) {
                Map<String, Object> report = commonReport(client);
                report.put("status", "failed");
                report.put("error", Map.of("code", code, "message", bounded));
                writeReportAndSentinel(CanonicalJson.encode(report));
            }
        } catch (Exception writeError) {
            LOGGER.error("Could not write Packwright capture failure evidence", writeError);
        }
        stopRequested = true;
        client.stop();
    }

    private String failureCode() {
        return switch (state) {
            case WAITING_FOR_WORLD, CREATING_WORLD, CONFIGURING_WORLD -> "client_launch_failed";
            case RELOADING_RESOURCES, WAITING_FOR_RELOAD_OVERLAY -> "resource_reload_failed";
            case PREPARING_SCENE, WAITING_FOR_EQUIP, WAITING_FOR_ANIMATION,
                    WAITING_FOR_FRAMES, CAPTURING ->
                    "scene_capture_failed";
            default -> "internal_error";
        };
    }

    private Scene currentScene() {
        return plan.scenes().get(sceneIndex);
    }

    private static LocalPlayer requirePlayer(Minecraft client) {
        if (client.player == null) throw new IllegalStateException("Client player is unavailable.");
        return client.player;
    }

    /** Observations scoped to one GameRenderer.render invocation, from HEAD through TAIL. */
    static final class RenderFrameEvidence {
        private boolean open;
        private boolean vanillaHandSubmissionSeen;
        private boolean submittedItemMatched;
        private boolean oppositeHandEmpty;
        private boolean vanillaItemRenderSeen;
        private boolean referenceArmSubmissionSeen;
        private boolean unexpectedReferenceArmSubmissionSeen;
        private int referenceArmSubmissionCount;

        void beginFrame() {
            reset();
            open = true;
        }

        void abandonFrame() {
            reset();
            open = false;
        }

        boolean isOpen() {
            return open;
        }

        void observeVanillaHand(boolean itemMatched, boolean emptyOppositeHand) {
            requireOpen();
            if (vanillaHandSubmissionSeen) {
                submittedItemMatched &= itemMatched;
                oppositeHandEmpty &= emptyOppositeHand;
            } else {
                submittedItemMatched = itemMatched;
                oppositeHandEmpty = emptyOppositeHand;
            }
            vanillaHandSubmissionSeen = true;
        }

        void observeVanillaItemRender() {
            requireOpen();
            vanillaItemRenderSeen = true;
        }

        void observeReferenceArm(boolean matching) {
            requireOpen();
            referenceArmSubmissionCount++;
            if (matching) {
                referenceArmSubmissionSeen = true;
            } else {
                unexpectedReferenceArmSubmissionSeen = true;
            }
        }

        RenderFrameAttestation finishFrame() {
            if (!open) {
                throw new IllegalStateException(
                        "Minecraft render TAIL did not match an open Packwright candidate frame.");
            }
            RenderFrameAttestation result = new RenderFrameAttestation(
                    vanillaHandSubmissionSeen,
                    submittedItemMatched,
                    oppositeHandEmpty,
                    vanillaItemRenderSeen,
                    referenceArmSubmissionSeen,
                    unexpectedReferenceArmSubmissionSeen,
                    referenceArmSubmissionCount);
            abandonFrame();
            return result;
        }

        private void requireOpen() {
            if (!open) {
                throw new IllegalStateException("Render evidence was submitted outside an open candidate frame.");
            }
        }

        private void reset() {
            vanillaHandSubmissionSeen = false;
            submittedItemMatched = false;
            oppositeHandEmpty = false;
            vanillaItemRenderSeen = false;
            referenceArmSubmissionSeen = false;
            unexpectedReferenceArmSubmissionSeen = false;
            referenceArmSubmissionCount = 0;
        }
    }

    record RenderFrameAttestation(
            boolean vanillaHandSubmissionSeen,
            boolean submittedItemMatched,
            boolean oppositeHandEmpty,
            boolean vanillaItemRenderSeen,
            boolean referenceArmSubmissionSeen,
            boolean unexpectedReferenceArmSubmissionSeen,
            int referenceArmSubmissionCount) {}

    private enum State {
        WAITING_FOR_WORLD,
        CREATING_WORLD,
        CONFIGURING_WORLD,
        RELOADING_RESOURCES,
        WAITING_FOR_RELOAD_OVERLAY,
        PREPARING_SCENE,
        WAITING_FOR_EQUIP,
        WAITING_FOR_ANIMATION,
        WAITING_FOR_FRAMES,
        CAPTURING,
        FINALIZING,
        DONE,
        FAILED
    }

    private record AsyncCapture(CapturedScene capture, String error) {
        static AsyncCapture completed(CapturedScene capture) {
            return new AsyncCapture(capture, null);
        }

        static AsyncCapture failed(String error) {
            return new AsyncCapture(null, error);
        }
    }

    private record CapturedScene(
            Scene scene,
            String filename,
            int width,
            int height,
            long bytes,
            String sha256) {
        Map<String, Object> toReport() {
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("sceneId", scene.id());
            report.put("sceneSha256", scene.sha256());
            report.put("scene", scene.toProtocolValue());
            report.put("path", "screenshots/" + filename);
            report.put("pngSha256", sha256);
            report.put("bytes", bytes);
            report.put("width", width);
            report.put("height", height);
            return report;
        }
    }

    private record LogEvidence(String path, String sha256, long bytes, List<String> excerpts) {
        Map<String, Object> toReport() {
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("path", path);
            report.put("sha256", sha256);
            report.put("bytes", bytes);
            report.put("resourceReloadSucceeded", true);
            report.put("excerpts", excerpts);
            return report;
        }
    }

    private static final class ResourceReloadEvidenceException extends IOException {
        private static final long serialVersionUID = 1L;

        ResourceReloadEvidenceException(String message) {
            super(message);
        }
    }
}
