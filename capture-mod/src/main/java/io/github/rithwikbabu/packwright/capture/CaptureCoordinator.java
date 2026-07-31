package io.github.rithwikbabu.packwright.capture;

import com.mojang.blaze3d.platform.Window;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.DeviceInfo;
import com.mojang.blaze3d.systems.RenderSystem;
import io.github.rithwikbabu.packwright.capture.io.AtomicFiles;
import io.github.rithwikbabu.packwright.capture.io.CanonicalJson;
import io.github.rithwikbabu.packwright.capture.io.Hashing;
import io.github.rithwikbabu.packwright.capture.io.PngEvidence;
import io.github.rithwikbabu.packwright.capture.mixin.AbstractContainerScreenAccessor;
import io.github.rithwikbabu.packwright.capture.mixin.CameraAccessor;
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
import io.github.rithwikbabu.packwright.capture.SceneFixtureExecutor.FixtureEvidence;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
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
import net.minecraft.client.CloudStatus;
import net.minecraft.client.GraphicsPreset;
import net.minecraft.client.Minecraft;
import net.minecraft.client.PreferredGraphicsApi;
import net.minecraft.client.gui.components.debug.DebugScreenEntries;
import net.minecraft.client.gui.components.debug.DebugScreenEntryStatus;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.ParticleStatus;
import net.minecraft.server.packs.repository.PackRepository;
import net.minecraft.world.Difficulty;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LightBlock;
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
    private static final String DATAPACK_PROVENANCE_PATH =
            "packwright/provenance/datapack-proposal.zip";
    private static final String RESOURCEPACK_PATH = "resourcepacks/packwright-proposal.zip";
    private static final String LOADABLE_DATAPACK_DIRECTORY =
            "saves/packwright-capture/datapacks";
    private static final Set<String> CLEAN_SELECTED_DATAPACK_IDS = Set.of("vanilla");
    private static final Set<String> CLEAN_AVAILABLE_DATAPACK_IDS = Set.of(
            "vanilla",
            "minecart_improvements",
            "redstone_experiments",
            "trade_rebalance");
    private static final String RESOURCE_RELOAD_STARTED_EXCERPT =
            "Packwright capture resource reload started";
    private static final String RESOURCE_RELOAD_EXCERPT =
            "Packwright capture resource reload completed";
    private static final String RESOURCE_DIAGNOSTICS_EXCERPT =
            "Packwright capture resource diagnostics clean";
    private static final String WORLD_READY_EXCERPT =
            "Packwright capture disposable world ready";
    private static final String WORLD_SETTINGS_EXCERPT =
            "Packwright capture world settings: seed=0; position=0.5,80,0.5; difficulty=normal; clock=6000; weather=clear; advance_time=false; advance_weather=false; spawn_mobs=false; random_tick_speed=0";
    private static final String PACK_ACTIVATION_EXCERPT =
            "Packwright capture project datapack hash-bound and not loaded; resource pack active";
    private static final int SETTLE_FRAMES = 3;
    private static final int MAX_CAMERA_READY_FRAMES = 120;
    private static final int WORLD_EQUIP_TICKS = 12;
    private static final int GUI_SETTLE_TICKS = 2;
    private static final int MAX_RUNTIME_TICKS = 36_000;
    private static final int MAX_WORLD_LOAD_TICKS = 6_000;
    private static final int MAX_ENVIRONMENT_SYNC_TICKS = 200;
    private static final int MAX_FIXTURE_SYNC_TICKS = 200;
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
    private int settlingTicksRemaining;
    private int fixtureAnimationTicksRemaining;
    private int animationTicksRemaining;
    private int animationTargetTick = -1;
    private int renderedSettleFrames;
    private int targetResizeAttempts;
    private int cameraReadyFrames;
    private final Map<String, ItemStack> itemStacks = new LinkedHashMap<>();
    private ItemStack headwearChestArmor = ItemStack.EMPTY;
    private CompletableFuture<Void> reloadFuture;
    private CompletableFuture<Void> worldSetupFuture;
    private CompletableFuture<FixtureEvidence> sceneServerSetupFuture;
    private CompletableFuture<Void> animationServerSetupFuture;
    private List<String> selectedDatapackIds = List.of();
    private List<String> selectedResourcePackIds = List.of();
    private AsyncCapture asyncCapture;
    private PlayerModelType playerModelOverride;
    private boolean stopRequested;
    private boolean environmentVerified;
    private int worldCreationStartedTick;
    private int resourceReloadCompletedTick;
    private int resourceReloadReadyTick;
    private int fixtureSetupCompletedTick;
    private int sceneSettledTicks;
    private int sceneAnimationTicksElapsed;
    private int environmentSyncTicks;
    private FixtureEvidence currentFixtureEvidence;
    private Map<String, Object> currentObservedFixture;
    private Map<String, Object> currentScaleReferenceAttestation;
    private SceneRuntimeAttestation currentRuntimeAttestation;
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

    boolean shouldFreezeClientTick() {
        return state == State.WAITING_FOR_FRAMES
                && sceneIndex < plan.scenes().size()
                && currentScene().animationState() != AnimationState.IDLE
                && animationTargetTick >= 0;
    }

    void applyPlannedCameraPose(net.minecraft.client.Camera camera) {
        if (state != State.WAITING_FOR_FRAMES || sceneIndex >= plan.scenes().size()) return;
        Scene scene = currentScene();
        boolean guiCamera = scene.context() != Context.WORLD;
        boolean studioCamera = scene.camera() == Camera.NEUTRAL;
        boolean headwearReviewCamera = scene.targetKind() == CapturePlan.TargetKind.HEADWEAR
                && scene.camera() != Camera.FIRST_PERSON;
        CapturePlan.CameraPose pose = scene.expectedRenderCameraPose();
        CameraAccessor accessor = (CameraAccessor) camera;
        // Neutral studio and GUI scenes declare an exact projection rather
        // than Minecraft's transient player FOV interpolation. Held gameplay
        // retains Minecraft's dynamic FOV; only its hash-bound camera pose is
        // stabilized against physical input and client interpolation.
        if (guiCamera || studioCamera || headwearReviewCamera) {
            accessor.packwrightCapture$setFov(scene.fov());
        }
        accessor.packwrightCapture$setPosition(pose.x(), pose.y(), pose.z());
        accessor.packwrightCapture$setRotation((float) pose.yaw(), (float) pose.pitch());
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
            boolean heldItemScene = scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM;
            if (heldItemScene
                    && (scene.animationState() == AnimationState.USE
                            || scene.animationState() == AnimationState.FIRE
                            || scene.animationState() == AnimationState.AIM)
                    && (!player.isUsingItem()
                            || player.getUsedItemHand() != expectedHand
                            || player.getTicksUsingItem() < scene.frame())) {
                fail(client, "scene_capture_failed", "Minecraft did not render the requested active-use tick state.");
                return;
            }
            if (heldItemScene
                    && (scene.animationState() == AnimationState.SWING
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
            if (heldItemScene
                    && scene.camera() == Camera.FIRST_PERSON
                    && (renderState.optionsRenderState.cameraType != CameraType.FIRST_PERSON
                            || cameraState.isPanoramicMode
                            || cameraState.entityRenderState.isSleeping
                            || renderState.guiRenderState.isHudHidden
                            || client.gameMode == null
                            || client.gameMode.getPlayerMode() == GameType.SPECTATOR)) {
                fail(client, "scene_capture_failed", "Minecraft rejected the required first-person hand-render predicates.");
                return;
            }
            if (heldItemScene
                    && scene.camera() == Camera.FIRST_PERSON
                    && (!frame.vanillaHandSubmissionSeen()
                            || !frame.submittedItemMatched()
                            || !frame.oppositeHandEmpty()
                            || !frame.vanillaItemRenderSeen())) {
                fail(client, "scene_capture_failed", "Minecraft did not submit the exact planned held item.");
                return;
            }
            String referenceArmFailure = referenceArmEvidenceFailure(
                    heldItemScene && scene.referenceArm(),
                    frame.referenceArmSubmissionCount(),
                    frame.referenceArmSubmissionSeen(),
                    frame.unexpectedReferenceArmSubmissionSeen());
            if (referenceArmFailure != null) {
                fail(client, "scene_capture_failed", referenceArmFailure);
                return;
            }
            boolean debugHitboxes = client.debugEntries.isCurrentlyEnabled(DebugScreenEntries.ENTITY_HITBOXES);
            boolean expectedDebugHitboxes = scene.viewKind() == CapturePlan.ViewKind.DEBUG_HITBOX_REFERENCE;
            if (debugHitboxes != expectedDebugHitboxes) {
                fail(client, "scene_capture_failed", "Minecraft debug-hitbox state does not match view authority.");
                return;
            }
            if (currentFixtureEvidence == null) {
                fail(client, "scene_capture_failed", "Minecraft has no attested fixture for the candidate frame.");
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
        CapturePlan.CameraPose observedCamera = sampleRenderCamera(client);
        CapturePlan.CameraPose frameCamera = sampleFrameCamera(client);
        if (!cameraPoseMatches(observedCamera, scene.expectedRenderCameraPose())
                || !cameraPoseMatches(frameCamera, scene.expectedRenderCameraPose())) {
            cameraReadyFrames++;
            renderedSettleFrames = 0;
            if (cameraReadyFrames > MAX_CAMERA_READY_FRAMES) {
                fail(
                        client,
                        "scene_capture_failed",
                        "Scene '" + scene.id() + "': " + cameraPoseMismatch(
                                observedCamera,
                                frameCamera,
                                scene.expectedRenderCameraPose()));
            }
            return;
        }
        try {
            currentScaleReferenceAttestation = ClientFixtureObserver.observeStudioScaleReference(
                    client, plan.studio());
            currentObservedFixture = ClientFixtureObserver.observe(
                    client,
                    scene,
                    environmentAnchorScene(scene),
                    plan.provenance().representation(),
                    plan.studio(),
                    currentFixtureEvidence);
        } catch (ClientFixtureObserver.ObservationPendingException pending) {
            renderedSettleFrames = 0;
            if (fixtureSetupCompletedTick >= 0
                    && elapsedTicks - fixtureSetupCompletedTick > MAX_FIXTURE_SYNC_TICKS) {
                fail(
                        client,
                        "scene_capture_failed",
                        "Scene '" + scene.id()
                                + "' did not reach client fixture/model readiness within "
                                + MAX_FIXTURE_SYNC_TICKS + " ticks: " + pending.getMessage());
            }
            return;
        } catch (IllegalStateException error) {
            fail(client, "scene_capture_failed", error.getMessage());
            return;
        }
        try {
            currentRuntimeAttestation = verifyAndSampleRuntime(client, scene);
        } catch (IllegalStateException error) {
            fail(client, "scene_capture_failed", error.getMessage());
            return;
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
        if (scene.targetKind() != CapturePlan.TargetKind.HELD_ITEM) return;
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
        if (scene.targetKind() != CapturePlan.TargetKind.HELD_ITEM
                || scene.camera() != Camera.FIRST_PERSON
                || !scene.referenceArm()) return null;
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
        if (scene.targetKind() != CapturePlan.TargetKind.HELD_ITEM) return;
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
        String backend = RenderSystem.getDevice().getDeviceInfo().backendName()
                .toLowerCase(Locale.ROOT);
        if (!backend.contains("opengl")) {
            throw new IllegalStateException(
                    "Authoritative Packwright captures require Minecraft's OpenGL backend.");
        }
        verifyStagedPacks();
        environmentVerified = true;
    }

    private VerifiedPackHashes verifyStagedPacks() throws IOException {
        Path game = Path.of(plan.execution().gameDirectory());
        requireNoLoadableDatapackContent(game.resolve(LOADABLE_DATAPACK_DIRECTORY));
        String resourcepack = verifyStagedPack(
                game.resolve(RESOURCEPACK_PATH),
                plan.provenance().resourcepackContentSha256(),
                "resource pack");
        String datapack = verifyStagedPack(
                game.resolve(DATAPACK_PROVENANCE_PATH),
                plan.provenance().datapackContentSha256(),
                "provenance-only datapack");
        return new VerifiedPackHashes(datapack, resourcepack);
    }

    private static String verifyStagedPack(Path path, String expectedSha256, String label)
            throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path)) {
            throw new IOException("Staged " + label + " is unavailable or unsafe.");
        }
        String actual = Hashing.sha256(path, MAX_PACK_BYTES);
        if (!actual.equals(expectedSha256)) {
            throw new IOException("Staged " + label + " does not match capture provenance.");
        }
        return actual;
    }

    static void requireNoLoadableDatapackContent(Path datapackDirectory) throws IOException {
        if (!Files.exists(datapackDirectory, LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(datapackDirectory)
                || !Files.isDirectory(datapackDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException(
                    "Disposable capture world's loadable datapack path is unsafe or not a directory.");
        }
        try (var entries = Files.list(datapackDirectory)) {
            if (entries.findAny().isPresent()) {
                throw new IOException(
                        "Disposable capture world contains loadable datapack content; visual capture never loads project or external datapacks.");
            }
        }
    }

    static String projectDatapackIsolationFailure(
            List<String> selectedDatapacks, List<String> availableDatapacks) {
        List<String> selectedExternal = selectedDatapacks.stream()
                .filter(id -> id.startsWith("file/"))
                .sorted()
                .toList();
        if (!selectedExternal.isEmpty()) {
            return "Disposable capture world selected external datapacks: " + selectedExternal + ".";
        }
        Set<String> selected = Set.copyOf(selectedDatapacks);
        if (!selected.equals(CLEAN_SELECTED_DATAPACK_IDS)) {
            return "Disposable capture world's selected datapacks differ from the clean 26.2 allowlist: "
                    + selectedDatapacks.stream().sorted().toList() + ".";
        }
        Set<String> available = Set.copyOf(availableDatapacks);
        if (!available.equals(CLEAN_AVAILABLE_DATAPACK_IDS)) {
            List<String> unexpected = available.stream()
                    .filter(id -> !CLEAN_AVAILABLE_DATAPACK_IDS.contains(id))
                    .sorted()
                    .toList();
            List<String> missing = CLEAN_AVAILABLE_DATAPACK_IDS.stream()
                    .filter(id -> !available.contains(id))
                    .sorted()
                    .toList();
            return "Disposable capture world's available datapacks differ from the clean 26.2 allowlist; unexpected="
                    + unexpected + ", missing=" + missing + ".";
        }
        return null;
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
                new LevelSettings.DifficultySettings(Difficulty.NORMAL, false, true),
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
        try {
            requireNoLoadableDatapackContent(Path.of(plan.execution().gameDirectory())
                    .resolve(LOADABLE_DATAPACK_DIRECTORY));
        } catch (IOException error) {
            throw new IllegalStateException(error.getMessage(), error);
        }
        PackRepository datapackRepository = server.getPackRepository();
        List<String> datapacks = datapackRepository.getSelectedIds().stream().sorted().toList();
        List<String> availableDatapacks =
                datapackRepository.getAvailableIds().stream().sorted().toList();
        String isolationFailure = projectDatapackIsolationFailure(
                datapacks, availableDatapacks);
        if (isolationFailure != null) {
            throw new IllegalStateException(isolationFailure);
        }
        selectedDatapackIds = datapacks;
        var playerId = client.player.getUUID();
        worldSetupFuture = server.submit(() -> configureWorld(server, playerId, plan.studio()));
        state = State.CONFIGURING_WORLD;
        LOGGER.info(
                "{}; selected datapacks={}; available datapacks={}",
                PACK_ACTIVATION_EXCERPT,
                datapacks,
                availableDatapacks);
    }

    private static void configureWorld(
            MinecraftServer server, java.util.UUID playerId, CapturePlan.Studio studio) {
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
        var floor = SceneFixtureExecutor.parseBlockState(level, studio.floorBlock());
        var backdrop = SceneFixtureExecutor.parseBlockState(level, studio.backdropBlock());
        for (int x = -16; x <= 16; x++) {
            for (int z = -16; z <= 16; z++) {
                level.setBlock(new net.minecraft.core.BlockPos(x, 79, z), floor, 3);
            }
            for (int y = 80; y <= 96; y++) {
                level.setBlock(new net.minecraft.core.BlockPos(x, y, 12), backdrop, 3);
            }
        }
        placeStudioScaleReference(level, studio.scaleReference());
        if (level.getDifficulty() != Difficulty.NORMAL
                || level.getDefaultClockTime() != 6_000L
                || rules.get(GameRules.ADVANCE_TIME)
                || rules.get(GameRules.ADVANCE_WEATHER)
                || rules.get(GameRules.SPAWN_MOBS)
                || rules.get(GameRules.SPAWN_MONSTERS)
                || rules.get(GameRules.RANDOM_TICK_SPEED) != 0) {
            throw new IllegalStateException("Disposable world settings did not become deterministic.");
        }
    }

    private static void placeStudioScaleReference(
            ServerLevel level, CapturePlan.StudioScaleReference reference) {
        List<net.minecraft.core.BlockPos> positions = scaleReferencePositions(reference);
        List<CapturePlan.BlockStateSpec> states = List.of(
                reference.firstBlock(), reference.secondBlock());
        for (int index = 0; index < positions.size(); index++) {
            var expected = SceneFixtureExecutor.parseBlockState(level, states.get(index));
            var position = positions.get(index);
            level.setBlock(position, expected, 3);
            if (!level.getBlockState(position).equals(expected)) {
                throw new IllegalStateException(
                        "Minecraft did not retain the hash-bound ordinary-block studio scale reference.");
            }
        }
    }

    static List<net.minecraft.core.BlockPos> scaleReferencePositions(
            CapturePlan.StudioScaleReference reference) {
        if (reference.lengthBlocks() != 2) {
            throw new IllegalArgumentException("Studio floor ruler must contain exactly two blocks.");
        }
        var origin = reference.origin();
        var first = new net.minecraft.core.BlockPos(origin.x(), origin.y(), origin.z());
        return List.of(first, first.east());
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
        selectedResourcePackIds = repository.getSelectedIds().stream().sorted().toList();
        // The diagnostic boundary must precede the asynchronous reload call.
        // Resource workers can log model/texture failures immediately; logging
        // this marker afterward would let those failures race ahead of the
        // segment that currentResourceReloadFailure() classifies.
        LOGGER.info(
                "{}; selected packs={}",
                RESOURCE_RELOAD_STARTED_EXCERPT,
                selectedResourcePackIds);
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
        parseRepresentationItems(client);
        state = State.PREPARING_SCENE;
        resourceReloadReadyTick = elapsedTicks;
        LOGGER.info(RESOURCE_DIAGNOSTICS_EXCERPT);
        LOGGER.info("{}; selected packs={}", RESOURCE_RELOAD_EXCERPT, selectedResourcePackIds);
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

    private void parseRepresentationItems(Minecraft client) {
        if (client.level == null) throw new IllegalStateException("Client level disappeared during item parsing.");
        itemStacks.clear();
        headwearChestArmor = ItemStack.EMPTY;
        for (Map.Entry<String, CapturePlan.RepresentationState> entry :
                plan.provenance().representation().states().entrySet()) {
            if (entry.getValue().itemStack() != null) {
                ItemStack parsed = SceneFixtureExecutor.parseItem(
                        entry.getValue().itemStack(), client.level.registryAccess());
                itemStacks.put(entry.getKey(), parsed);
                if (plan.provenance().representation().targetKind()
                        == CapturePlan.TargetKind.HEADWEAR) {
                    validateHeadwearItem(parsed);
                }
            }
        }
        CapturePlan.Review review = plan.provenance().representation().review();
        if (review != null && review.chestArmorItemStack() != null) {
            headwearChestArmor = SceneFixtureExecutor.parseItem(
                    review.chestArmorItemStack(), client.level.registryAccess());
            var chestEquippable = headwearChestArmor.get(DataComponents.EQUIPPABLE);
            if (chestEquippable == null
                    || chestEquippable.slot() != net.minecraft.world.entity.EquipmentSlot.CHEST
                    || !chestEquippable.canBeEquippedBy(
                            BuiltInRegistries.ENTITY_TYPE.wrapAsHolder(
                                    net.minecraft.world.entity.EntityTypes.PLAYER))) {
                throw new IllegalStateException(
                        "Headwear compatibility chest armor must parse to a player-compatible minecraft:equippable chest item.");
            }
        }
        if (review != null && review.inventoryItemStack() != null) {
            ItemStack inventory = SceneFixtureExecutor.parseItem(
                    review.inventoryItemStack(), client.level.registryAccess());
            for (String stateId : plan.provenance().representation().states().keySet()) {
                itemStacks.putIfAbsent(stateId, inventory);
            }
        }
    }

    private void validateHeadwearItem(ItemStack stack) {
        var equippable = stack.get(DataComponents.EQUIPPABLE);
        if (equippable == null
                || equippable.slot() != net.minecraft.world.entity.EquipmentSlot.HEAD) {
            throw new IllegalStateException(
                    "Headwear item must parse to minecraft:equippable with slot=head.");
        }
        CapturePlan.HeadwearSpec declared = plan.provenance().representation().headwear();
        boolean hasEquipmentModel = equippable.assetId().isPresent();
        if (hasEquipmentModel != declared.renderMode().equals("equipment_model")) {
            throw new IllegalStateException(
                    "Headwear renderMode does not match the parsed equippable equipment asset.");
        }
        String actualOverlay = equippable.cameraOverlay().map(Object::toString).orElse(null);
        if (!java.util.Objects.equals(actualOverlay, declared.cameraOverlay())) {
            throw new IllegalStateException(
                    "Headwear cameraOverlay does not match the parsed equippable component.");
        }
        boolean needsArmorStand = plan.scenes().stream()
                .anyMatch(scene -> scene.targetKind() == CapturePlan.TargetKind.HEADWEAR
                        && "armor_stand".equals(scene.fixture().subject()));
        if (needsArmorStand
                && !equippable.canBeEquippedBy(
                        BuiltInRegistries.ENTITY_TYPE.wrapAsHolder(
                                net.minecraft.world.entity.EntityTypes.ARMOR_STAND))) {
            throw new IllegalStateException(
                    "Headwear equippable allowed_entities excludes armor stands.");
        }
        boolean needsPlayer = plan.scenes().stream()
                .anyMatch(scene -> scene.targetKind() == CapturePlan.TargetKind.HEADWEAR
                        && "player".equals(scene.fixture().subject()));
        if (needsPlayer
                && !equippable.canBeEquippedBy(
                        BuiltInRegistries.ENTITY_TYPE.wrapAsHolder(
                                net.minecraft.world.entity.EntityTypes.PLAYER))) {
            throw new IllegalStateException("Headwear equippable allowed_entities excludes players.");
        }
    }

    private void prepareScene(Minecraft client) {
        LocalPlayer player = requirePlayer(client);
        Scene scene = currentScene();
        renderedSettleFrames = 0;
        targetResizeAttempts = 0;
        cameraReadyFrames = 0;
        renderFrameEvidence.abandonFrame();
        renderPredicatesLogged = false;
        animationTargetTick = -1;
        sceneServerSetupFuture = null;
        animationServerSetupFuture = null;
        currentFixtureEvidence = null;
        currentObservedFixture = null;
        currentScaleReferenceAttestation = null;
        currentRuntimeAttestation = null;
        sceneSettledTicks = 0;
        sceneAnimationTicksElapsed = 0;
        environmentSyncTicks = 0;
        fixtureSetupCompletedTick = -1;
        resize(client, scene.width(), scene.height());
        applyStudioOptions(client, scene);
        player.stopUsingItem();
        player.swinging = false;
        player.swingingArm = null;
        player.swingTime = 0;
        player.oAttackAnim = 0.0F;
        player.attackAnim = 0.0F;
        player.setInvisible(false);
        client.gui.toastManager().clear();
        // Drive held-use through Minecraft's own key/action loop. Without a
        // held use mapping, the client releases an item on the next tick even
        // after a successful gameMode.useItem() call.
        client.options.keyUse.setDown(false);
        player.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
        player.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
        player.setItemSlot(net.minecraft.world.entity.EquipmentSlot.CHEST, ItemStack.EMPTY);
        player.getInventory().setItem(0, ItemStack.EMPTY);
        player.getInventory().setItem(1, ItemStack.EMPTY);
        playerModelOverride = scene.playerModel() == PlayerModel.STEVE
                ? PlayerModelType.WIDE
                : PlayerModelType.SLIM;
        player.setPos(scene.cameraPose().x(), scene.cameraPose().y(), scene.cameraPose().z());
        player.setYRot((float) scene.cameraPose().yaw());
        player.setXRot((float) scene.cameraPose().pitch());
        player.setYHeadRot((float) scene.cameraPose().yaw());
        player.setYBodyRot((float) scene.cameraPose().yaw());
        player.setOldPosAndRot();

        ItemStack sceneStack = itemStacks.containsKey(scene.fixture().stateId())
                ? itemForScene(scene)
                : ItemStack.EMPTY;
        if (scene.context() == Context.WORLD) {
            prepareWorldScene(client, player, scene, sceneStack);
        } else {
            prepareGuiScene(client, player, scene, sceneStack);
            if (scene.targetKind() == CapturePlan.TargetKind.BLOCK) {
                synchronizeServerFixture(client, player, scene);
            } else {
                synchronizeServerGuiItem(client, player, scene, sceneStack);
            }
        }
        equipTicksRemaining = scene.context() == Context.WORLD
                ? scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM
                                || scene.targetKind() == CapturePlan.TargetKind.HEADWEAR
                        ? WORLD_EQUIP_TICKS
                        : 0
                : GUI_SETTLE_TICKS;
        settlingTicksRemaining = scene.settlingTicks();
        fixtureAnimationTicksRemaining = SceneFixtureExecutor.requiredAnimationTicks(scene);
        state = State.WAITING_FOR_EQUIP;
    }

    private ItemStack itemForScene(Scene scene) {
        ItemStack planned = itemStacks.get(scene.fixture().stateId());
        if (planned == null) {
            throw new IllegalStateException("Scene has no hash-bound item-stack representation state.");
        }
        ItemStack result = planned.copyWithCount(scene.stackCount(planned.getCount()));
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
        boolean heldItemScene = scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM;
        if (client.gui.hud.isHidden() == heldItemScene) client.gui.hud.toggle();
        client.gameRenderer.mainCamera().disablePanoramicMode();
        client.options.fov().set(scene.fov());
        client.options.guiScale().set(scene.guiScale());
        client.options.mainHand().set(HumanoidArm.RIGHT);
        client.options.setCameraType(switch (scene.camera()) {
            case FIRST_PERSON, NEUTRAL -> CameraType.FIRST_PERSON;
            case THIRD_PERSON_BACK -> CameraType.THIRD_PERSON_BACK;
            case THIRD_PERSON_FRONT -> CameraType.THIRD_PERSON_FRONT;
        });
        player.setPos(scene.cameraPose().x(), scene.cameraPose().y(), scene.cameraPose().z());
        player.setYRot((float) scene.cameraPose().yaw());
        player.setXRot((float) scene.cameraPose().pitch());
        player.setYHeadRot((float) scene.cameraPose().yaw());
        float bodyYaw = heldItemScene && scene.camera() != Camera.FIRST_PERSON
                ? (scene.id().contains("left") ? -35 : 35)
                : (float) scene.cameraPose().yaw();
        player.setYBodyRot(bodyYaw);
        player.setOldPosAndRot();
        client.debugEntries.setStatus(
                DebugScreenEntries.ENTITY_HITBOXES,
                scene.viewKind() == CapturePlan.ViewKind.DEBUG_HITBOX_REFERENCE
                        ? DebugScreenEntryStatus.ALWAYS_ON
                        : DebugScreenEntryStatus.NEVER);
        client.debugEntries.setOverlayVisible(false);
        if (heldItemScene) {
            InteractionHand hand = scene.hand() == Hand.RIGHT
                    ? InteractionHand.MAIN_HAND
                    : InteractionHand.OFF_HAND;
            synchronizeServerHeldItem(client, player, scene, hand, sceneStack);
            player.setItemInHand(hand, sceneStack);
            synchronizeVanillaHandRenderer(client, player);
        } else {
            synchronizeServerFixture(client, player, scene);
            if (scene.fixture().kind().equals("measurement_control")) {
                Scene base = authoritativeBaseScene(scene);
                if (scene.targetKind() == CapturePlan.TargetKind.HEADWEAR) {
                    player.setInvisible(false);
                    applyLocalHeadwearPose(player, base.fixture().pose());
                    player.setItemSlot(
                            net.minecraft.world.entity.EquipmentSlot.HEAD, ItemStack.EMPTY);
                    player.setItemSlot(
                            net.minecraft.world.entity.EquipmentSlot.CHEST, ItemStack.EMPTY);
                }
            } else if (scene.targetKind() == CapturePlan.TargetKind.HEADWEAR) {
                boolean equippedPlayer = scene.fixture().subject().equals("player");
                player.setInvisible(scene.fixture().subject().equals("armor_stand"));
                player.setYHeadRot(scene.fixture().subjectYaw());
                player.setYBodyRot(scene.fixture().subjectYaw());
                applyLocalHeadwearPose(player, scene.fixture().pose());
                player.setItemSlot(
                        net.minecraft.world.entity.EquipmentSlot.HEAD,
                        equippedPlayer ? sceneStack : ItemStack.EMPTY);
                player.setItemSlot(
                        net.minecraft.world.entity.EquipmentSlot.CHEST,
                        scene.fixture().chestArmor() ? headwearChestArmor : ItemStack.EMPTY);
            }
        }
    }

    private void applyStudioOptions(Minecraft client, Scene scene) {
        CapturePlan.Studio studio = plan.studio();
        client.options.preferredGraphicsBackend().set(PreferredGraphicsApi.OPENGL);
        client.options.cloudStatus().set(CloudStatus.OFF);
        client.options.particles().set(ParticleStatus.MINIMAL);
        client.options.entityShadows().set(true);
        client.options.bobView().set(false);
        client.options.renderDistance().set(studio.renderDistance());
        client.options.simulationDistance().set(studio.simulationDistance());
        client.options.fov().set(scene.fov());
        client.options.guiScale().set(scene.guiScale());
        // The exact individual overrides intentionally form Minecraft's CUSTOM
        // preset. Claiming FANCY here is false after clouds/particles are bound.
        client.options.graphicsPreset().set(GraphicsPreset.CUSTOM);
        if (client.options.preferredGraphicsBackend().get() != PreferredGraphicsApi.OPENGL
                || client.options.graphicsPreset().get() != GraphicsPreset.CUSTOM
                || client.options.cloudStatus().get() != CloudStatus.OFF
                || client.options.particles().get() != ParticleStatus.MINIMAL
                || !client.options.entityShadows().get()
                || client.options.bobView().get()
                || client.options.renderDistance().get() != studio.renderDistance()
                || client.options.simulationDistance().get() != studio.simulationDistance()) {
            throw new IllegalStateException("Minecraft rejected deterministic studio render settings.");
        }
    }

    private SceneRuntimeAttestation verifyAndSampleRuntime(Minecraft client, Scene scene) {
        LocalPlayer player = requirePlayer(client);
        CapturePlan.CameraPose actual = sampleRenderCamera(client);
        CapturePlan.CameraPose frameActual = sampleFrameCamera(client);
        CapturePlan.CameraPose expected = scene.expectedRenderCameraPose();
        net.minecraft.client.Camera camera = client.gameRenderer.mainCamera();
        if (!camera.isInitialized()
                || camera.entity() != player
                || !cameraPoseMatches(actual, expected)
                || !cameraPoseMatches(frameActual, expected)) {
            throw new IllegalStateException(
                    "Scene '" + scene.id() + "': "
                            + cameraPoseMismatch(actual, frameActual, expected));
        }
        CameraType expectedType = switch (scene.camera()) {
            case FIRST_PERSON, NEUTRAL -> CameraType.FIRST_PERSON;
            case THIRD_PERSON_BACK -> CameraType.THIRD_PERSON_BACK;
            case THIRD_PERSON_FRONT -> CameraType.THIRD_PERSON_FRONT;
        };
        CameraType actualType = client.options.getCameraType();
        if (actualType != expectedType
                || client.options.fov().get() != scene.fov()
                || Math.abs(camera.getFov() - scene.fov()) > 0.01F
                || client.options.guiScale().get() != scene.guiScale()
                || client.debugEntries.isOverlayVisible()) {
            throw new IllegalStateException(
                    "Minecraft camera settings diverged for scene '" + scene.id()
                            + "': cameraType=" + actualType + " expected=" + expectedType
                            + ", optionFov=" + client.options.fov().get()
                            + " expected=" + scene.fov()
                            + ", renderedFov=" + camera.getFov()
                            + ", guiScale=" + client.options.guiScale().get()
                            + " expectedGuiScale=" + scene.guiScale()
                            + ", debugUi=" + client.debugEntries.isOverlayVisible()
                            + " expected=false.");
        }
        if (!near(player.getX(), scene.cameraPose().x(), 0.002)
                || !near(player.getY(), scene.cameraPose().y(), 0.002)
                || !near(player.getZ(), scene.cameraPose().z(), 0.002)) {
            throw new IllegalStateException(
                    "Minecraft player feet anchor diverged from the hash-bound scene pose.");
        }
        if (playerModelOverride == null || player.getSkin().model() != playerModelOverride) {
            throw new IllegalStateException(
                    "Minecraft player model did not match the planned Steve/Alex variant.");
        }
        if (client.level == null) {
            throw new IllegalStateException("Minecraft client level disappeared during runtime attestation.");
        }
        Scene environmentScene = environmentAnchorScene(scene);
        net.minecraft.core.BlockPos subject = SceneFixtureExecutor.subjectPosition(environmentScene);
        net.minecraft.core.BlockPos lightingSample =
                SceneFixtureExecutor.lightingSamplePosition(environmentScene);
        net.minecraft.core.BlockPos skyLightProbe =
                SceneFixtureExecutor.skyLightProbePosition(environmentScene);
        String actualBiome = client.level.getBiome(subject)
                .unwrapKey()
                .map(key -> key.identifier().toString())
                .orElseThrow(() -> new IllegalStateException(
                        "Minecraft client biome has no registry identity."));
        long actualTime = client.level.getDefaultClockTime();
        boolean actualRaining = client.level.isRaining();
        int actualSkyLight = client.level.getBrightness(LightLayer.SKY, skyLightProbe);
        if (!actualBiome.equals(scene.environment().biome())
                || actualTime != scene.environment().time()
                || actualRaining
                || actualSkyLight != scene.environment().skyLight()) {
            throw new IllegalStateException(
                    "Minecraft environment diverged from the scene: biome="
                            + actualBiome + " expected=" + scene.environment().biome()
                            + ", time=" + actualTime + " expected=" + scene.environment().time()
                            + ", raining=" + actualRaining + " expected=false"
                            + ", skyLight=" + actualSkyLight + " expected="
                            + scene.environment().skyLight() + '.');
        }
        CapturePlan.LightSource plannedLight = scene.environment().lightSource();
        net.minecraft.core.BlockPos lightPosition = lightingSample.offset(
                plannedLight.offset().x(), plannedLight.offset().y(), plannedLight.offset().z());
        var lightState = client.level.getBlockState(lightPosition);
        int actualLightSourceLevel = lightState.is(Blocks.LIGHT)
                ? lightState.getValue(LightBlock.LEVEL)
                : 0;
        int actualBlockLight = client.level.getBrightness(LightLayer.BLOCK, lightingSample);
        int expectedLightSourceLevel = plannedLight.level();
        if (actualBlockLight != scene.environment().blockLight()
                || actualLightSourceLevel != expectedLightSourceLevel) {
            throw new IllegalStateException(
                    "Minecraft studio block light diverged from the scene: subject="
                            + actualBlockLight + " expected=" + scene.environment().blockLight()
                            + ", source=" + actualLightSourceLevel + " expectedSource="
                            + expectedLightSourceLevel + '.');
        }
        CapturePlan.Environment actualEnvironment = new CapturePlan.Environment(
                actualBiome,
                Math.toIntExact(actualTime),
                "clear",
                scene.environment().lightProfile(),
                actualSkyLight,
                actualBlockLight,
                new CapturePlan.LightSource(
                        actualLightSourceLevel, plannedLight.offset()));
        if (currentScaleReferenceAttestation == null) {
            throw new IllegalStateException(
                    "Minecraft has no live ordinary-block scale-reference attestation for this frame.");
        }
        String actualCameraMode = switch (actualType) {
            case FIRST_PERSON -> "first_person";
            case THIRD_PERSON_BACK -> "third_person_back";
            case THIRD_PERSON_FRONT -> "third_person_front";
        };
        return new SceneRuntimeAttestation(
                actual,
                actualCameraMode,
                scene.context().id(),
                Math.round(camera.getFov()),
                client.options.guiScale().get(),
                scene.hand().id(),
                playerModelOverride == PlayerModelType.WIDE ? "steve" : "alex",
                actualEnvironment,
                currentScaleReferenceAttestation);
    }

    private static void applyLocalHeadwearPose(LocalPlayer player, String pose) {
        player.setDeltaMovement(0, 0, 0);
        player.walkAnimation.stop();
        player.setPose(switch (pose) {
            case "idle", "walk" -> net.minecraft.world.entity.Pose.STANDING;
            case "crouch" -> net.minecraft.world.entity.Pose.CROUCHING;
            case "swim" -> net.minecraft.world.entity.Pose.SWIMMING;
            case "glide" -> net.minecraft.world.entity.Pose.FALL_FLYING;
            default -> throw new IllegalStateException("Unsupported headwear pose escaped validation.");
        });
        if (pose.equals("walk")) player.walkAnimation.update(1.0F, 1.0F, 1.0F);
    }

    private static boolean near(double left, double right, double tolerance) {
        return Math.abs(left - right) <= tolerance;
    }

    private static double angleDifference(double left, double right) {
        double raw = Math.abs(left - right) % 360.0;
        return Math.min(raw, 360.0 - raw);
    }

    private static CapturePlan.CameraPose sampleRenderCamera(Minecraft client) {
        net.minecraft.client.Camera camera = client.gameRenderer.mainCamera();
        var position = camera.position();
        return new CapturePlan.CameraPose(
                position.x, position.y, position.z, camera.yaw(), camera.xRot());
    }

    private static CapturePlan.CameraPose sampleFrameCamera(Minecraft client) {
        var state = client.gameRenderer.gameRenderState().levelRenderState.cameraRenderState;
        if (!state.initialized || state.pos == null) {
            return new CapturePlan.CameraPose(
                    Double.NaN, Double.NaN, Double.NaN, Double.NaN, Double.NaN);
        }
        return new CapturePlan.CameraPose(
                state.pos.x, state.pos.y, state.pos.z, state.yRot, state.xRot);
    }

    static boolean cameraPoseMatches(
            CapturePlan.CameraPose actual, CapturePlan.CameraPose expected) {
        return near(actual.x(), expected.x(), 0.002)
                && near(actual.y(), expected.y(), 0.002)
                && near(actual.z(), expected.z(), 0.002)
                && angleDifference(actual.yaw(), expected.yaw()) <= 0.05
                && Math.abs(actual.pitch() - expected.pitch()) <= 0.05;
    }

    static String cameraPoseMismatch(
            CapturePlan.CameraPose actual, CapturePlan.CameraPose expected) {
        return cameraPoseMismatch(actual, actual, expected);
    }

    static String cameraPoseMismatch(
            CapturePlan.CameraPose actual,
            CapturePlan.CameraPose frameActual,
            CapturePlan.CameraPose expected) {
        return "Minecraft render camera did not reach the hash-bound pose within the bounded readiness window: actual=("
                + actual.x() + ',' + actual.y() + ',' + actual.z() + ';'
                + actual.yaw() + ',' + actual.pitch() + ") frame=("
                + frameActual.x() + ',' + frameActual.y() + ',' + frameActual.z() + ';'
                + frameActual.yaw() + ',' + frameActual.pitch() + ") expected=("
                + expected.x() + ',' + expected.y() + ',' + expected.z() + ';'
                + expected.yaw() + ',' + expected.pitch() + ").";
    }

    private boolean clientEnvironmentReady(Minecraft client, Scene scene) {
        if (client.level == null) return false;
        Scene environmentScene = environmentAnchorScene(scene);
        net.minecraft.core.BlockPos subject = SceneFixtureExecutor.subjectPosition(environmentScene);
        net.minecraft.core.BlockPos lightingSample =
                SceneFixtureExecutor.lightingSamplePosition(environmentScene);
        net.minecraft.core.BlockPos skyLightProbe =
                SceneFixtureExecutor.skyLightProbePosition(environmentScene);
        String biome = client.level.getBiome(subject)
                .unwrapKey()
                .map(key -> key.identifier().toString())
                .orElse(null);
        CapturePlan.LightSource plannedLight = scene.environment().lightSource();
        net.minecraft.core.BlockPos lightPosition = lightingSample.offset(
                plannedLight.offset().x(), plannedLight.offset().y(), plannedLight.offset().z());
        var lightState = client.level.getBlockState(lightPosition);
        int lightSourceLevel = lightState.is(Blocks.LIGHT)
                ? lightState.getValue(LightBlock.LEVEL)
                : 0;
        int expectedSourceLevel = plannedLight.level();
        return scene.environment().biome().equals(biome)
                && client.level.getDefaultClockTime() == scene.environment().time()
                && !client.level.isRaining()
                && client.level.getBrightness(LightLayer.SKY, skyLightProbe)
                        == scene.environment().skyLight()
                && client.level.getBrightness(LightLayer.BLOCK, lightingSample)
                        == scene.environment().blockLight()
                && lightSourceLevel == expectedSourceLevel;
    }

    private String clientEnvironmentMismatch(Minecraft client, Scene scene) {
        if (client.level == null) return "client level is unavailable";
        Scene environmentScene = environmentAnchorScene(scene);
        net.minecraft.core.BlockPos subject = SceneFixtureExecutor.subjectPosition(environmentScene);
        net.minecraft.core.BlockPos lightingSample =
                SceneFixtureExecutor.lightingSamplePosition(environmentScene);
        net.minecraft.core.BlockPos skyLightProbe =
                SceneFixtureExecutor.skyLightProbePosition(environmentScene);
        CapturePlan.LightSource plannedLight = scene.environment().lightSource();
        net.minecraft.core.BlockPos lightPosition = lightingSample.offset(
                plannedLight.offset().x(), plannedLight.offset().y(), plannedLight.offset().z());
        var lightState = client.level.getBlockState(lightPosition);
        int lightSourceLevel = lightState.is(Blocks.LIGHT)
                ? lightState.getValue(LightBlock.LEVEL)
                : 0;
        String biome = client.level.getBiome(subject)
                .unwrapKey()
                .map(key -> key.identifier().toString())
                .orElse("unregistered");
        return "biome=" + biome + " expected=" + scene.environment().biome()
                + ", time=" + client.level.getDefaultClockTime()
                + " expected=" + scene.environment().time()
                + ", raining=" + client.level.isRaining() + " expected=false"
                + ", skyLight=" + client.level.getBrightness(LightLayer.SKY, skyLightProbe)
                + " expected=" + scene.environment().skyLight()
                + ", blockLight=" + client.level.getBrightness(LightLayer.BLOCK, lightingSample)
                + " expected=" + scene.environment().blockLight()
                + ", lightSource=" + lightSourceLevel
                + " expected=" + plannedLight.level()
                + ", subject=" + subject.toShortString()
                + ", skyLightProbe=" + skyLightProbe.toShortString()
                + ", lightingSample=" + lightingSample.toShortString()
                + ", lightPosition=" + lightPosition.toShortString();
    }

    private void synchronizeServerHeldItem(
            Minecraft client,
            LocalPlayer player,
            Scene scene,
            InteractionHand hand,
            ItemStack sceneStack) {
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
            SceneFixtureExecutor.configureEnvironment(server.overworld(), serverPlayer, scene);
            serverPlayer.getInventory().setSelectedSlot(0);
            serverPlayer.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
            serverPlayer.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
            serverPlayer.setItemInHand(hand, serverStack);
            serverPlayer.containerMenu.broadcastChanges();
            serverPlayer.teleportTo(
                    server.overworld(),
                    scene.cameraPose().x(),
                    scene.cameraPose().y(),
                    scene.cameraPose().z(),
                    Set.of(),
                    (float) scene.cameraPose().yaw(),
                    (float) scene.cameraPose().pitch(),
                    true);
            return FixtureEvidence.item(
                    plan.provenance().representation().strategy().id(),
                    scene.fixture().stateId(),
                    BuiltInRegistries.ITEM.getKey(serverStack.getItem()).toString(),
                    true);
        });
    }

    private void synchronizeServerFixture(Minecraft client, LocalPlayer player, Scene scene) {
        MinecraftServer server = client.getSingleplayerServer();
        if (server == null) {
            throw new IllegalStateException("Integrated server disappeared during fixture setup.");
        }
        java.util.UUID playerId = player.getUUID();
        ItemStack inventoryStack = scene.context() == Context.INVENTORY
                ? itemForScene(scene).copy()
                : ItemStack.EMPTY;
        sceneServerSetupFuture = server.submit(() -> {
            ServerPlayer serverPlayer = server.getPlayerList().getPlayer(playerId);
            if (serverPlayer == null) {
                throw new IllegalStateException("Integrated-server capture player is unavailable.");
            }
            serverPlayer.teleportTo(
                    server.overworld(),
                    scene.cameraPose().x(),
                    scene.cameraPose().y(),
                    scene.cameraPose().z(),
                    Set.of(),
                    (float) scene.cameraPose().yaw(),
                    (float) scene.cameraPose().pitch(),
                    true);
            FixtureEvidence evidence;
            if (scene.fixture().kind().equals("measurement_control")) {
                evidence = SceneFixtureExecutor.applyMeasurementControl(
                        server.overworld(),
                        serverPlayer,
                        scene,
                        authoritativeBaseScene(scene),
                        plan.provenance().representation());
            } else {
                evidence = SceneFixtureExecutor.apply(
                        server.overworld(), serverPlayer, scene, plan.provenance().representation());
            }
            if (!inventoryStack.isEmpty()) {
                serverPlayer.getInventory().setSelectedSlot(0);
                serverPlayer.getInventory().setItem(0, inventoryStack);
                serverPlayer.containerMenu.broadcastChanges();
            }
            return evidence;
        });
    }

    private void synchronizeServerGuiItem(
            Minecraft client, LocalPlayer player, Scene scene, ItemStack sceneStack) {
        MinecraftServer server = client.getSingleplayerServer();
        if (server == null) {
            throw new IllegalStateException("Integrated server disappeared during GUI setup.");
        }
        java.util.UUID playerId = player.getUUID();
        String itemId = BuiltInRegistries.ITEM.getKey(sceneStack.getItem()).toString();
        sceneServerSetupFuture = server.submit(() -> {
            ServerPlayer serverPlayer = server.getPlayerList().getPlayer(playerId);
            if (serverPlayer == null) {
                throw new IllegalStateException("Integrated-server capture player is unavailable.");
            }
            SceneFixtureExecutor.configureEnvironment(server.overworld(), serverPlayer, scene);
            serverPlayer.setDeltaMovement(0, 0, 0);
            serverPlayer.teleportTo(
                    server.overworld(),
                    scene.cameraPose().x(),
                    scene.cameraPose().y(),
                    scene.cameraPose().z(),
                    Set.of(),
                    (float) scene.cameraPose().yaw(),
                    (float) scene.cameraPose().pitch(),
                    true);
            return FixtureEvidence.item(
                    plan.provenance().representation().strategy().id(),
                    scene.fixture().stateId(),
                    itemId,
                    false);
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
            currentFixtureEvidence = sceneServerSetupFuture.join();
            sceneServerSetupFuture = null;
            fixtureSetupCompletedTick = elapsedTicks;
        }
        if (!clientEnvironmentReady(client, currentScene())) {
            environmentSyncTicks++;
            if (environmentSyncTicks > MAX_ENVIRONMENT_SYNC_TICKS) {
                throw new IllegalStateException(
                        "Minecraft client did not acknowledge the exact server-applied studio environment for scene '"
                                + currentScene().id() + "' within "
                                + MAX_ENVIRONMENT_SYNC_TICKS + " ticks: "
                                + clientEnvironmentMismatch(client, currentScene()));
            }
            return;
        }
        if (equipTicksRemaining > 0) {
            equipTicksRemaining--;
        }
        if (equipTicksRemaining > 0) return;
        if (settlingTicksRemaining > 0) {
            settlingTicksRemaining--;
            sceneSettledTicks++;
            return;
        }
        if (fixtureAnimationTicksRemaining > 0) {
            fixtureAnimationTicksRemaining--;
            sceneAnimationTicksElapsed++;
            return;
        }
        Scene scene = currentScene();
        LocalPlayer player = requirePlayer(client);
        if (scene.context() == Context.WORLD) {
            if (client.gameMode == null || client.gameMode.getPlayerMode() != GameType.CREATIVE) {
                throw new IllegalStateException("Capture client is not in creative mode.");
            }
            if (scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM) {
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
            } else if (scene.targetKind() == CapturePlan.TargetKind.HEADWEAR
                    && !scene.fixture().kind().equals("measurement_control")) {
                applyLocalHeadwearPose(player, scene.fixture().pose());
                ItemStack actual = player.getItemBySlot(net.minecraft.world.entity.EquipmentSlot.HEAD);
                boolean bare = scene.fixture().subject().equals("bare_control")
                        || scene.fixture().subject().equals("armor_stand");
                if ((bare && !actual.isEmpty())
                        || (!bare && !exactStack(actual, itemForScene(scene)))) {
                    throw new IllegalStateException(
                            "Exact planned headwear did not survive integrated-server synchronization.");
                }
                ItemStack actualChest = player.getItemBySlot(
                        net.minecraft.world.entity.EquipmentSlot.CHEST);
                if ((scene.fixture().chestArmor()
                                && !exactStack(actualChest, headwearChestArmor))
                        || (!scene.fixture().chestArmor() && !actualChest.isEmpty())) {
                    throw new IllegalStateException(
                            "Exact planned headwear compatibility chest armor did not survive integrated-server synchronization.");
                }
                net.minecraft.world.entity.Pose expectedPose = switch (scene.fixture().pose()) {
                    case "idle", "walk" -> net.minecraft.world.entity.Pose.STANDING;
                    case "crouch" -> net.minecraft.world.entity.Pose.CROUCHING;
                    case "swim" -> net.minecraft.world.entity.Pose.SWIMMING;
                    case "glide" -> net.minecraft.world.entity.Pose.FALL_FLYING;
                    default -> throw new IllegalStateException(
                            "Unsupported headwear pose escaped validation.");
                };
                if (player.getPose() != expectedPose
                        || (scene.fixture().pose().equals("walk")
                                && !player.walkAnimation.isMoving())) {
                    throw new IllegalStateException(
                            "Minecraft did not retain the exact planned headwear body pose.");
                }
            }
            client.gui.toastManager().clear();
            LOGGER.info(
                    "Packwright capture world scene ready; id={}; mode={}; handsBusy={}; mainHand={}; offHand={}",
                    scene.id(),
                    client.gameMode.getPlayerMode(),
                    player.isHandsBusy(),
                    BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()),
                    BuiltInRegistries.ITEM.getKey(player.getOffhandItem().getItem()));
            if (scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM) {
                beginAnimation(client, player, scene);
            }
        }
        animationTicksRemaining = scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM
                ? scene.frame()
                : 0;
        if (animationServerSetupFuture != null || animationTicksRemaining > 0) {
            state = State.WAITING_FOR_ANIMATION;
        } else {
            stabilizeLocalCameraAnchor(player, scene);
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
                stabilizeLocalCameraAnchor(player, scene);
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
        stabilizeLocalCameraAnchor(player, scene);
        prepareAnimationTarget(scene);
        state = State.WAITING_FOR_FRAMES;
    }

    /**
     * Minecraft interpolates both entity position and view rotation from the
     * previous client tick. A scene can otherwise exhaust the bounded render
     * readiness window before the next 20 Hz tick when the client is rendering
     * at very high frame rates. Snap both endpoints only after the integrated
     * server has acknowledged the scene so the hash-bound pose remains the
     * ordinary vanilla camera composition, not an injected camera transform.
     */
    private static void stabilizeLocalCameraAnchor(LocalPlayer player, Scene scene) {
        player.setPos(scene.cameraPose().x(), scene.cameraPose().y(), scene.cameraPose().z());
        player.setYRot((float) scene.cameraPose().yaw());
        player.setXRot((float) scene.cameraPose().pitch());
        player.setYHeadRot((float) scene.cameraPose().yaw());
        player.setOldPosAndRot();
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
            if (currentRuntimeAttestation == null
                    || currentFixtureEvidence == null
                    || currentObservedFixture == null) {
                throw new IOException(
                        "Minecraft screenshot has no verified runtime or fixture attestation.");
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
                    evidence.sha256(),
                    plan.studio().sha256(),
                    scene.appliedFixtureSha256(plan.provenance().representation()),
                    sceneSettledTicks,
                    renderedSettleFrames,
                    scene.targetKind() == CapturePlan.TargetKind.HELD_ITEM
                            ? scene.frame()
                            : sceneAnimationTicksElapsed,
                    currentRuntimeAttestation,
                    currentFixtureEvidence,
                    currentObservedFixture));
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
        if (!text.contains(PACK_ACTIVATION_EXCERPT)) {
            throw new IOException("Minecraft client log has no safe pack-activation evidence.");
        }
        return new LogEvidence(
                "logs/client.log",
                Hashing.sha256(bytes),
                bytes.length,
                List.of(
                        WORLD_READY_EXCERPT,
                        WORLD_SETTINGS_EXCERPT,
                        PACK_ACTIVATION_EXCERPT,
                        RESOURCE_DIAGNOSTICS_EXCERPT,
                        RESOURCE_RELOAD_EXCERPT));
    }

    private Map<String, Object> successReport(Minecraft client, LogEvidence log) throws IOException {
        Map<String, Object> report = commonReport(client);
        report.put("status", "complete");
        report.put("packActivation", packActivationAttestation(client));
        report.put("views", captures.stream().map(CapturedScene::toReport).toList());
        report.put("measurements", analyzeMeasurements());
        report.put("log", log.toReport());
        return report;
    }

    private List<Map<String, Object>> analyzeMeasurements() throws IOException {
        Map<String, CapturedScene> byId = new LinkedHashMap<>();
        for (CapturedScene capture : captures) byId.put(capture.scene().id(), capture);
        List<Map<String, Object>> results = new ArrayList<>();
        for (CapturedScene primary : captures) {
            for (CapturePlan.MeasurementIntent intent : primary.scene().measurementIntents()) {
                List<String> sceneIds;
                if (intent.sourceSceneIds() != null) {
                    sceneIds = intent.sourceSceneIds();
                } else {
                    List<String> defaults = new ArrayList<>();
                    defaults.add(primary.scene().id());
                    defaults.addAll(primary.scene().comparisonSceneIds());
                    sceneIds = defaults.stream().distinct().sorted().toList();
                }
                List<CapturedScene> sources = new ArrayList<>();
                for (String id : sceneIds) {
                    CapturedScene source = byId.get(id);
                    if (source == null) {
                        results.add(skippedMeasurement(
                                intent, sceneIds, "A declared comparison framebuffer is missing."));
                        sources.clear();
                        break;
                    }
                    sources.add(source);
                }
                if (sources.isEmpty()) continue;
                boolean debugPrimary = primary.scene().viewKind()
                        == CapturePlan.ViewKind.DEBUG_HITBOX_REFERENCE;
                if (sources.stream().anyMatch(source ->
                        !source.scene().requiredForAuthority()
                                && source.scene().viewKind()
                                        != CapturePlan.ViewKind.MEASUREMENT_CONTROL
                                && !(debugPrimary && source == primary))) {
                    results.add(skippedMeasurement(
                            intent,
                            sceneIds,
                            "Augmented or debug framebuffers cannot satisfy an authoritative pixel measurement."));
                    continue;
                }
                MeasurementValue measured;
                try {
                    measured = measureClientPixels(primary, sources, intent);
                } catch (UnsupportedOperationException unsupported) {
                    results.add(skippedMeasurement(intent, sceneIds, unsupported.getMessage()));
                    continue;
                }
                double value = measured.value();
                String status = measurementStatus(value, intent.threshold());
                Map<String, Object> result = measurementBase(intent, sceneIds, status);
                result.put("value", value);
                result.put(
                        "message",
                        measured.message());
                result.put(
                        "sourcePngSha256s",
                        sources.stream()
                                .sorted(java.util.Comparator.comparing(source -> source.scene().id()))
                                .map(CapturedScene::sha256)
                                .toList());
                results.add(Map.copyOf(result));
            }
        }
        return List.copyOf(results);
    }

    private MeasurementValue measureClientPixels(
            CapturedScene primary,
            List<CapturedScene> sources,
            CapturePlan.MeasurementIntent intent) throws IOException {
        String metric = intent.metric();
        if (metric.equals("pairwise_pixel_delta")
                || metric.equals("screen_coverage")
                || metric.equals("animation_stability")
                || metric.equals("texture_variant_resolution")) {
            if (sources.size() != 2 || intent.unit().equals("dot")) {
                throw unsupported("This changed-pixel metric requires exactly two bound framebuffers.");
            }
            CapturedScene other = sources.getFirst() == primary
                    ? sources.getLast() : sources.getFirst();
            double value = ClientPixelAnalysis.changedPercent(
                    readPixels(primary), readPixels(other), primary.width(), primary.height());
            return new MeasurementValue(
                    value,
                    "Exact percentage of unequal ABGR client framebuffer pixels across the two hash-bound frames.");
        }
        if (metric.equals("lighting_separation")) {
            if (sources.size() != 2 || !intent.unit().equals("percent")) {
                throw unsupported("Lighting separation requires exactly one day/low-light framebuffer pair.");
            }
            CapturedScene other = sources.getFirst() == primary
                    ? sources.getLast() : sources.getFirst();
            return new MeasurementValue(
                    ClientPixelAnalysis.meanAbsoluteLuminanceDeltaPercent(
                            readPixels(primary), readPixels(other), primary.width(), primary.height()),
                    "Mean absolute sRGB-luminance difference across the exact day/low-light client framebuffer pair, normalized to percent.");
        }
        CapturedScene control = sources.stream()
                .filter(source -> source.scene().viewKind()
                        == CapturePlan.ViewKind.MEASUREMENT_CONTROL)
                .findFirst()
                .orElse(null);
        if (metric.equals("frame_retention")
                || metric.equals("first_person_obstruction")
                || metric.equals("overlay_coverage")) {
            if (control == null || !intent.unit().equals("percent")) {
                throw unsupported("This subject-mask metric requires an exact matching empty-subject control.");
            }
            ClientPixelAnalysis.SubjectMask mask = ClientPixelAnalysis.compare(
                    readPixels(primary), readPixels(control), primary.width(), primary.height());
            if (metric.equals("frame_retention")) {
                return new MeasurementValue(
                        mask.frameRetentionPercent(),
                        "Conservative 2-D clipping proxy: 100 minus subject-mask pixels touching the two-pixel framebuffer edge band; it does not infer off-screen geometry.");
            }
            return new MeasurementValue(
                    mask.coverageRatio() * 100.0,
                    "Exact client-pixel screen coverage derived from the matching empty-subject control; supplemental QA only.");
        }
        if (metric.equals("visibility_occlusion")) {
            CapturedScene visible = sources.stream()
                    .filter(source -> source != primary && source != control
                            && source.scene().requiredForAuthority())
                    .findFirst()
                    .orElse(null);
            if (control == null || visible == null || !intent.unit().equals("percent")) {
                throw unsupported("Occlusion retention requires occluded, visible, and empty-control frames.");
            }
            return new MeasurementValue(
                    ClientPixelAnalysis.retainedSubjectPercent(
                            readPixels(primary), readPixels(visible), readPixels(control),
                            primary.width(), primary.height()),
                    "Percentage of the visible empty-control-derived subject mask retained in the occluded client frame.");
        }
        if (metric.equals("hitbox_containment")
                || metric.equals("hitbox_empty_space")
                || metric.equals("collision_interaction_footprint_delta")) {
            CapturedScene authoritative = sources.stream()
                    .filter(source -> source.scene().requiredForAuthority())
                    .findFirst()
                    .orElse(null);
            if (primary.scene().viewKind() != CapturePlan.ViewKind.DEBUG_HITBOX_REFERENCE
                    || control == null || authoritative == null) {
                throw unsupported("Hitbox QA requires a debug frame, authoritative base, and matched empty control.");
            }
            ClientPixelAnalysis.HitboxQa qa = ClientPixelAnalysis.hitboxQa(
                    readPixels(primary), readPixels(authoritative), readPixels(control),
                    primary.width(), primary.height());
            double value = switch (metric) {
                case "hitbox_containment" -> qa.containmentPercent();
                case "hitbox_empty_space" -> qa.emptySpacePercent();
                default -> qa.footprintDeltaPixels();
            };
            return new MeasurementValue(
                    value,
                    "Augmented QA 2-D proxy from the F3+B overlay bounding box versus the empty-control-derived subject mask; never authoritative release evidence.");
        }
        throw unsupported(
                "This metric requires calibrated geometry or semantic segmentation not available from the bound client framebuffers.");
    }

    private static UnsupportedOperationException unsupported(String message) {
        return new UnsupportedOperationException(message);
    }

    private ClientPixelAnalysis.SubjectMask changedPixels(
            CapturedScene primary, List<CapturedScene> sources)
            throws IOException {
        int[] baseline = readPixels(primary);
        long changed = 0;
        long total = 0;
        long edgeChanged = 0;
        for (CapturedScene comparison : sources) {
            if (comparison == primary) continue;
            if (comparison.width() != primary.width() || comparison.height() != primary.height()) {
                throw new IOException("Pixel comparison scenes have different framebuffer dimensions.");
            }
            int[] pixels = readPixels(comparison);
            if (pixels.length != baseline.length) {
                throw new IOException("Pixel comparison scenes have different decoded sizes.");
            }
            ClientPixelAnalysis.SubjectMask pair = ClientPixelAnalysis.compare(
                    baseline, pixels, primary.width(), primary.height());
            changed += pair.changedPixels();
            total += pair.totalPixels();
            edgeChanged += pair.edgeChangedPixels();
        }
        if (total == 0) throw new IOException("Pixel comparison has no control pixels.");
        return new ClientPixelAnalysis.SubjectMask(changed, total, edgeChanged);
    }

    private int[] readPixels(CapturedScene capture) throws IOException {
        Path path = paths.outputDirectory().resolve("screenshots").resolve(capture.filename());
        try (var input = Files.newInputStream(path); NativeImage image = NativeImage.read(input)) {
            if (image.getWidth() != capture.width() || image.getHeight() != capture.height()) {
                throw new IOException("Captured PNG dimensions changed before pixel analysis.");
            }
            return image.getPixelsABGR();
        }
    }

    private static String measurementStatus(
            double value, CapturePlan.MeasurementThreshold threshold) {
        if (threshold == null) return "warning";
        if (threshold.comparison().equals("above")) {
            if (value >= threshold.failure()) return "failed";
            if (value >= threshold.warning()) return "warning";
        } else {
            if (value <= threshold.failure()) return "failed";
            if (value <= threshold.warning()) return "warning";
        }
        return "passed";
    }

    private static Map<String, Object> skippedMeasurement(
            CapturePlan.MeasurementIntent intent, List<String> sceneIds, String message) {
        Map<String, Object> result = measurementBase(intent, sceneIds, "skipped");
        result.put("message", message);
        result.put("sourcePngSha256s", List.of());
        return Map.copyOf(result);
    }

    private static Map<String, Object> measurementBase(
            CapturePlan.MeasurementIntent intent, List<String> sceneIds, String status) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", intent.id());
        result.put("metric", intent.metric());
        result.put("authority", intent.authority());
        result.put("requiredForReadiness", intent.requiredForReadiness());
        result.put("sceneIds", sceneIds);
        result.put("status", status);
        result.put("unit", intent.unit());
        if (intent.threshold() != null) {
            result.put("threshold", intent.threshold().toProtocolValue());
        }
        return result;
    }

    private Map<String, Object> commonReport(Minecraft client) {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("schemaVersion", 3);
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
        identity.put("packActivation", provenance.packActivation().toProtocolValue());
        identity.put("representationSha256", provenance.representationSha256());
        identity.put("studioSha256", plan.studio().sha256());
        identity.put("clientJarSha1", provenance.client().jarSha1());
        identity.put("clientJarSha256", provenance.client().jarSha256());
        identity.put("captureModId", provenance.captureMod().id());
        identity.put("captureModVersion", provenance.captureMod().version());
        identity.put("captureModSha256", provenance.captureMod().sha256());
        return identity;
    }

    private Map<String, Object> packActivationAttestation(Minecraft client) throws IOException {
        VerifiedPackHashes verified = verifyStagedPacks();
        MinecraftServer server = client.getSingleplayerServer();
        if (server == null) {
            throw new IOException("Integrated server disappeared before pack activation attestation.");
        }
        PackRepository datapackRepository = server.getPackRepository();
        selectedDatapackIds = datapackRepository.getSelectedIds().stream().sorted().toList();
        List<String> availableDatapacks =
                datapackRepository.getAvailableIds().stream().sorted().toList();
        String datapackFailure = projectDatapackIsolationFailure(
                selectedDatapackIds, availableDatapacks);
        if (datapackFailure != null) throw new IOException(datapackFailure);
        selectedResourcePackIds = client.getResourcePackRepository()
                .getSelectedIds().stream().sorted().toList();
        if (!selectedResourcePackIds.contains(REQUIRED_RESOURCE_PACK)) {
            throw new IOException("Project resource pack was not active when evidence finalized.");
        }
        Map<String, Object> datapack = Map.ofEntries(
                Map.entry("mode", plan.provenance().packActivation().datapack()),
                Map.entry("archivePath", DATAPACK_PROVENANCE_PATH),
                Map.entry("archiveSha256", verified.datapackSha256()),
                Map.entry("selected", false),
                Map.entry("selectedPackIds", selectedDatapackIds));
        Map<String, Object> resourcepack = Map.ofEntries(
                Map.entry("mode", plan.provenance().packActivation().resourcepack()),
                Map.entry("archivePath", RESOURCEPACK_PATH),
                Map.entry("archiveSha256", verified.resourcepackSha256()),
                Map.entry("selected", true),
                Map.entry("selectedPackIds", selectedResourcePackIds));
        return Map.of("datapack", datapack, "resourcepack", resourcepack);
    }

    private Map<String, Object> runtime(Minecraft client) {
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
        runtime.put("studioSha256", plan.studio().sha256());
        Map<String, Object> settings = Map.ofEntries(
                Map.entry("preferredGraphicsBackend", client.options.preferredGraphicsBackend().get().getSerializedName()),
                Map.entry("graphicsMode", client.options.graphicsPreset().get().getSerializedName()),
                Map.entry("clouds", client.options.cloudStatus().get() == CloudStatus.OFF
                        ? "off"
                        : client.options.cloudStatus().get().getSerializedName()),
                Map.entry("particles", client.options.particles().get().name().toLowerCase(Locale.ROOT)),
                Map.entry("entityShadows", client.options.entityShadows().get()),
                Map.entry("viewBobbing", client.options.bobView().get()),
                Map.entry("renderDistance", client.options.renderDistance().get()),
                Map.entry("simulationDistance", client.options.simulationDistance().get()),
                Map.entry("debugUi", client.debugEntries.isOverlayVisible()));
        runtime.put("settings", settings);
        runtime.put("settingsSha256", Hashing.sha256(CanonicalJson.encode(settings)));
        runtime.put("resourceReloadReadyTick", resourceReloadReadyTick);
        runtime.put("modelBakeReadyTick", resourceReloadReadyTick);
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
        sentinel.put("schemaVersion", 3);
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

    private Scene environmentAnchorScene(Scene scene) {
        return scene.fixture().kind().equals("measurement_control")
                ? authoritativeBaseScene(scene)
                : scene;
    }

    private Scene authoritativeBaseScene(Scene control) {
        for (Scene candidate : plan.scenes()) {
            if (candidate.requiredForAuthority()
                    && candidate.baseSceneId().equals(control.baseSceneId())) {
                return candidate;
            }
        }
        throw new IllegalStateException(
                "Measurement control lost its authoritative base scene after plan validation.");
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

    private record MeasurementValue(double value, String message) {}

    private record VerifiedPackHashes(String datapackSha256, String resourcepackSha256) {}

    private record SceneRuntimeAttestation(
            CapturePlan.CameraPose cameraPose,
            String cameraMode,
            String context,
            int fov,
            int guiScale,
            String hand,
            String playerModel,
            CapturePlan.Environment environment,
            Map<String, Object> scaleReference) {}

    private record CapturedScene(
            Scene scene,
            String filename,
            int width,
            int height,
            long bytes,
            String sha256,
            String studioSha256,
            String appliedFixtureSha256,
            int actualSettledTicks,
            int renderedSettleFrames,
            int actualAnimationTick,
            SceneRuntimeAttestation runtimeAttestation,
            FixtureEvidence fixtureEvidence,
            Map<String, Object> observedFixture) {
        Map<String, Object> toReport() {
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("sceneId", scene.id());
            report.put("sceneSha256", scene.sha256());
            report.put("scene", scene.toProtocolValue());
            report.put("representationSha256", scene.representationSha256());
            report.put("studioSha256", studioSha256);
            report.put("fixtureSha256", Hashing.sha256(
                    CanonicalJson.encode(scene.fixture().toProtocolValue())));
            report.put("appliedFixtureSha256", appliedFixtureSha256);
            report.put("observedFixture", observedFixture);
            report.put("observedFixtureSha256", Hashing.sha256(
                    CanonicalJson.encode(observedFixture)));
            report.put("path", "screenshots/" + filename);
            report.put("pngSha256", sha256);
            report.put("bytes", bytes);
            report.put("width", width);
            report.put("height", height);
            report.put("actualSettledTicks", actualSettledTicks);
            report.put("renderedSettleFrames", renderedSettleFrames);
            report.put("actualAnimationTick", actualAnimationTick);
            report.put("actualCameraPose", runtimeAttestation.cameraPose().toProtocolValue());
            report.put("actualCameraMode", runtimeAttestation.cameraMode());
            report.put("actualContext", runtimeAttestation.context());
            report.put("actualFov", runtimeAttestation.fov());
            report.put("actualGuiScale", runtimeAttestation.guiScale());
            report.put("actualHand", runtimeAttestation.hand());
            report.put("actualPlayerModel", runtimeAttestation.playerModel());
            report.put("actualEnvironment", runtimeAttestation.environment().toProtocolValue());
            report.put("actualScaleReference", runtimeAttestation.scaleReference());
            report.put("actualScaleReferenceSha256", Hashing.sha256(
                    CanonicalJson.encode(runtimeAttestation.scaleReference())));
            report.put("resourceReloadReady", true);
            report.put("modelBakeReady", true);
            report.put("fixtureEvidence", fixtureEvidence.toReport());
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
            report.put("modelBakeSucceeded", true);
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
