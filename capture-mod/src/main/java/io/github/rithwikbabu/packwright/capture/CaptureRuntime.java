package io.github.rithwikbabu.packwright.capture;

import io.github.rithwikbabu.packwright.capture.io.AtomicFiles;
import io.github.rithwikbabu.packwright.capture.io.CanonicalJson;
import io.github.rithwikbabu.packwright.capture.io.Hashing;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePaths;
import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan;
import io.github.rithwikbabu.packwright.capture.protocol.ProtocolException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Camera;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Static bridge called by the Fabric entrypoint and narrowly scoped Mixins. */
public final class CaptureRuntime {
    private static final Logger LOGGER = LoggerFactory.getLogger(PackwrightCaptureClient.MOD_ID);
    private static CaptureCoordinator coordinator;
    private static BootstrapFailure bootstrapFailure;
    private static boolean bootstrapFailureWritten;

    private CaptureRuntime() {}

    public static synchronized void initialize() {
        if (coordinator != null || bootstrapFailure != null) return;
        CapturePaths paths = null;
        try {
            paths = CapturePaths.fromSystemProperties();
            requireEmptyOutput(paths.outputDirectory());
            CapturePlan plan = CapturePlan.read(paths.plan());
            validateExecution(paths, plan);
            byte[] planBytes = Files.readAllBytes(paths.plan());
            coordinator = new CaptureCoordinator(paths, plan, Hashing.sha256(planBytes));
            LOGGER.info(
                    "Loaded Packwright capture execution {} with {} scenes",
                    plan.execution().executionId(),
                    plan.scenes().size());
        } catch (Exception error) {
            String message = boundedMessage(error);
            bootstrapFailure = new BootstrapFailure(paths, message);
            LOGGER.error("Packwright capture bootstrap failed: {}", message);
        }
    }

    public static void onClientTick(Minecraft client) {
        CaptureCoordinator active;
        BootstrapFailure failed;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
            failed = bootstrapFailure;
        }
        if (active != null) {
            active.onClientTick(client);
        } else if (failed != null) {
            writeBootstrapFailureAndStop(client, failed);
        }
    }

    public static boolean shouldFreezeClientTick() {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        return active != null && active.shouldFreezeClientTick();
    }

    public static void onRenderedFrame(Minecraft client, boolean renderLevel) {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        if (active != null) active.onRenderedFrame(client, renderLevel);
    }

    public static void onRenderFrameStarted() {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        if (active != null) active.onRenderFrameStarted();
    }

    public static void applyPlannedCameraPose(Camera camera) {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        if (active != null) active.applyPlannedCameraPose(camera);
    }

    public static void onVanillaHandSubmission(
            LocalPlayer player, ItemStack submittedMain, ItemStack submittedOff) {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        if (active != null) active.onVanillaHandSubmission(player, submittedMain, submittedOff);
    }

    public static HumanoidArm referenceArm() {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        return active == null ? null : active.referenceArm();
    }

    public static void onReferenceArmSubmission(HumanoidArm arm) {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        if (active != null) active.onReferenceArmSubmission(arm);
    }

    public static void onVanillaItemRender(ItemStack stack, ItemDisplayContext displayContext) {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        if (active != null) active.onVanillaItemRender(stack, displayContext);
    }

    public static PlayerModelType playerModelOverride() {
        CaptureCoordinator active;
        synchronized (CaptureRuntime.class) {
            active = coordinator;
        }
        return active == null ? null : active.playerModelOverride();
    }

    private static void requireEmptyOutput(Path output) throws IOException, ProtocolException {
        try (var entries = Files.list(output)) {
            if (entries.findAny().isPresent()) {
                throw new ProtocolException("Capture output directory must be empty.");
            }
        }
    }

    private static void validateExecution(CapturePaths paths, CapturePlan plan)
            throws IOException, ProtocolException {
        CapturePlan.Execution execution = plan.execution();
        if (!Path.of(execution.outputDirectory()).equals(paths.outputDirectory())) {
            throw new ProtocolException("Capture output path does not match the hash-bound execution scope.");
        }
        String executionProperty = System.getProperty("packwright.capture.execution", "");
        if (!execution.executionId().equals(executionProperty)) {
            throw new ProtocolException("Capture execution id does not match the launcher property.");
        }
        Path gameDirectory = Path.of(execution.gameDirectory());
        if (Files.isSymbolicLink(gameDirectory)
                || !Files.isDirectory(gameDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new ProtocolException("Disposable game directory is unavailable or unsafe.");
        }
        Path realGame = gameDirectory.toRealPath();
        Path realOutput = paths.outputDirectory().toRealPath();
        if (realOutput.equals(realGame) || !realOutput.startsWith(realGame)) {
            throw new ProtocolException("Capture output escaped the disposable game directory.");
        }
        validateCaptureOnlySaves(gameDirectory);
    }

    static void validateCaptureOnlySaves(Path gameDirectory)
            throws IOException, ProtocolException {
        Path saves = gameDirectory.resolve("saves");
        if (Files.isSymbolicLink(saves)
                || !Files.isDirectory(saves, LinkOption.NOFOLLOW_LINKS)) {
            throw new ProtocolException(
                    "Disposable game directory has no safe capture-only saves directory.");
        }
        try (var entries = Files.list(saves)) {
            if (entries.anyMatch(path -> !path.getFileName().toString().equals("packwright-capture"))) {
                throw new ProtocolException(
                        "Capture client refuses a game directory containing any user save.");
            }
        }
        Path captureSave = saves.resolve("packwright-capture");
        if (Files.isSymbolicLink(captureSave)
                || !Files.isDirectory(captureSave, LinkOption.NOFOLLOW_LINKS)) {
            throw new ProtocolException("Disposable capture save staging is unavailable or unsafe.");
        }
        try (var entries = Files.list(captureSave)) {
            if (entries.findAny().isPresent()) {
                throw new ProtocolException(
                        "Disposable capture save staging must be empty before Minecraft creates the world.");
            }
        }
    }

    private static synchronized void writeBootstrapFailureAndStop(
            Minecraft client, BootstrapFailure failure) {
        if (bootstrapFailureWritten) return;
        bootstrapFailureWritten = true;
        if (failure.paths() != null) {
            try {
                byte[] report = CanonicalJson.encode(Map.of(
                        "schemaVersion", 3,
                        "status", "failed",
                        "error", failure.message()));
                AtomicFiles.writeNew(
                        failure.paths().outputDirectory().resolve("capture-bootstrap-failed.json"),
                        report);
                String reportHash = Hashing.sha256(report);
                AtomicFiles.writeNew(
                        failure.paths().outputDirectory().resolve("capture-bootstrap-failed.sha256"),
                        (reportHash + '\n').getBytes(StandardCharsets.US_ASCII));
            } catch (IOException writeError) {
                LOGGER.error("Could not write Packwright bootstrap failure report", writeError);
            }
        }
        client.stop();
    }

    static String boundedMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) message = error.getClass().getSimpleName();
        message = message.replace('\r', ' ').replace('\n', ' ');
        return message.length() <= 512 ? message : message.substring(0, 512);
    }

    private record BootstrapFailure(CapturePaths paths, String message) {}
}
