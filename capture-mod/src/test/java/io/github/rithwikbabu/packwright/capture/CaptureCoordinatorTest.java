package io.github.rithwikbabu.packwright.capture;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.rithwikbabu.packwright.capture.protocol.CapturePlan;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.packs.repository.ServerPacksSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class CaptureCoordinatorTest {
    private static final String START = "Packwright capture resource reload started";
    private static final List<String> CLEAN_AVAILABLE_DATAPACKS = List.of(
            "minecart_improvements",
            "redstone_experiments",
            "trade_rebalance",
            "vanilla");

    @TempDir
    Path temporaryDirectory;

    @Test
    void acceptsCleanReloadSegment() {
        assertNull(CaptureCoordinator.resourceReloadFailure(
                "[INFO]: boot\n[INFO]: " + START + "\n[INFO]: Created item atlas\n"));
    }

    @Test
    void rejectsMissingModelAndTextureWarnings() {
        assertNotNull(CaptureCoordinator.resourceReloadFailure(
                "[INFO]: " + START + "\n[Worker/WARN]: Unable to load model arcana:staff\n"));
        assertNotNull(CaptureCoordinator.resourceReloadFailure(
                "[INFO]: " + START + "\n[Worker/WARN]: Missing texture arcana:item/staff\n"));
    }

    @Test
    void ignoresErrorsBeforeLatestReloadMarker() {
        assertNull(CaptureCoordinator.resourceReloadFailure(
                "[Render thread/ERROR]: old unrelated failure\n"
                        + "[INFO]: " + START + "\n[INFO]: reload clean\n"));
    }

    @Test
    void rejectsAnyErrorAfterReloadMarker() {
        assertNotNull(CaptureCoordinator.resourceReloadFailure(
                "[INFO]: " + START + "\n[Worker/ERROR]: resource parser exploded\n"));
    }

    @Test
    void rejectsMissingReloadMarker() {
        assertNotNull(CaptureCoordinator.resourceReloadFailure("[INFO]: ordinary client log\n"));
    }

    @Test
    void acceptsOnlyAnUnaugmentedAuthoritativeVanillaFrame() {
        assertNull(CaptureCoordinator.referenceArmEvidenceFailure(false, 0, false, false));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(false, 0, true, false));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(false, 0, false, true));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(false, 1, false, true));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(false, 1, true, false));
    }

    @Test
    void requiresExactlyOneMatchingAugmentationForAnOptInScaleReferenceFrame() {
        assertNull(CaptureCoordinator.referenceArmEvidenceFailure(true, 1, true, false));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(true, 0, false, false));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(true, 1, false, false));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(true, 1, false, true));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(true, 1, true, true));
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(true, 2, true, false));
        assertThrows(
                IllegalArgumentException.class,
                () -> CaptureCoordinator.referenceArmEvidenceFailure(false, -1, false, false));
    }

    @Test
    void resetsEveryObservationAtTheNextRenderHead() {
        CaptureCoordinator.RenderFrameEvidence evidence =
                new CaptureCoordinator.RenderFrameEvidence();

        evidence.beginFrame();
        evidence.observeVanillaHand(true, true);
        evidence.observeVanillaItemRender();
        evidence.observeReferenceArm(true);
        CaptureCoordinator.RenderFrameAttestation first = evidence.finishFrame();
        assertTrue(first.vanillaHandSubmissionSeen());
        assertTrue(first.submittedItemMatched());
        assertTrue(first.oppositeHandEmpty());
        assertTrue(first.vanillaItemRenderSeen());
        assertTrue(first.referenceArmSubmissionSeen());
        assertFalse(first.unexpectedReferenceArmSubmissionSeen());
        assertEquals(1, first.referenceArmSubmissionCount());

        evidence.beginFrame();
        CaptureCoordinator.RenderFrameAttestation next = evidence.finishFrame();
        assertFalse(next.vanillaHandSubmissionSeen());
        assertFalse(next.submittedItemMatched());
        assertFalse(next.oppositeHandEmpty());
        assertFalse(next.vanillaItemRenderSeen());
        assertFalse(next.referenceArmSubmissionSeen());
        assertFalse(next.unexpectedReferenceArmSubmissionSeen());
        assertEquals(0, next.referenceArmSubmissionCount());
        assertThrows(IllegalStateException.class, evidence::finishFrame);
    }

    @Test
    void rejectsMultipleOrMismatchedSubmissionsWithinOneFrame() {
        CaptureCoordinator.RenderFrameEvidence evidence =
                new CaptureCoordinator.RenderFrameEvidence();
        evidence.beginFrame();
        evidence.observeReferenceArm(true);
        evidence.observeReferenceArm(true);
        CaptureCoordinator.RenderFrameAttestation multiple = evidence.finishFrame();
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(
                true,
                multiple.referenceArmSubmissionCount(),
                multiple.referenceArmSubmissionSeen(),
                multiple.unexpectedReferenceArmSubmissionSeen()));

        evidence.beginFrame();
        evidence.observeReferenceArm(false);
        CaptureCoordinator.RenderFrameAttestation mismatch = evidence.finishFrame();
        assertNotNull(CaptureCoordinator.referenceArmEvidenceFailure(
                true,
                mismatch.referenceArmSubmissionCount(),
                mismatch.referenceArmSubmissionSeen(),
                mismatch.unexpectedReferenceArmSubmissionSeen()));
    }

    @Test
    void cameraReadinessUsesStrictBoundedPoseToleranceAndDetailedEvidence() {
        CapturePlan.CameraPose expected = new CapturePlan.CameraPose(0.5, 81.62, 5.5, 180, 0);
        assertTrue(CaptureCoordinator.cameraPoseMatches(
                new CapturePlan.CameraPose(0.501, 81.619, 5.5, 180.04, 0.04), expected));
        CapturePlan.CameraPose stale = new CapturePlan.CameraPose(0.5, 80, 5.5, 0, 0);
        assertFalse(CaptureCoordinator.cameraPoseMatches(stale, expected));
        String message = CaptureCoordinator.cameraPoseMismatch(stale, expected);
        assertTrue(message.contains("actual=(0.5,80.0,5.5;0.0,0.0)"));
        assertTrue(message.contains("expected=(0.5,81.62,5.5;180.0,0.0)"));
    }

    @Test
    void skyLightAttestationUsesOpenSkyProbeAboveControlledCeilingGeometry() {
        BlockPos ceilingSubject = new BlockPos(0, 83, 5);
        BlockPos ordinaryBlockCeiling = ceilingSubject.above();

        BlockPos probe = SceneFixtureExecutor.skyLightProbePosition(ceilingSubject);

        assertEquals(new BlockPos(0, SceneFixtureExecutor.OPEN_SKY_PROBE_Y, 5), probe);
        assertTrue(probe.getY() > ordinaryBlockCeiling.getY());
        assertEquals(ceilingSubject.getX(), probe.getX());
        assertEquals(ceilingSubject.getZ(), probe.getZ());
    }

    @Test
    void cleanWorldAllowsVanillaSelectionAndKnownBundledPacks() {
        assertNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of("vanilla"), CLEAN_AVAILABLE_DATAPACKS));
    }

    @Test
    void cleanAvailabilityAllowlistMatchesThePinnedClientJar() {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        var repository = ServerPacksSource.createVanillaTrustedRepository();
        repository.reload();

        assertEquals(
                Set.copyOf(CLEAN_AVAILABLE_DATAPACKS),
                Set.copyOf(repository.getAvailableIds()));
    }

    @Test
    void rejectsEverySelectedExternalOrNonDefaultDatapack() {
        assertNotNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of("file/unrelated.zip", "vanilla"), CLEAN_AVAILABLE_DATAPACKS));
        assertNotNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of("trade_rebalance", "vanilla"), CLEAN_AVAILABLE_DATAPACKS));
        assertNotNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of(), CLEAN_AVAILABLE_DATAPACKS));
    }

    @Test
    void rejectsUnexpectedOrMissingAvailableDatapacks() {
        assertNotNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of("vanilla"),
                List.of(
                        "file/unselected-external.zip",
                        "minecart_improvements",
                        "redstone_experiments",
                        "trade_rebalance",
                        "vanilla")));
        assertNotNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of("vanilla"),
                List.of("minecart_improvements", "redstone_experiments", "vanilla")));
        assertNotNull(CaptureCoordinator.projectDatapackIsolationFailure(
                List.of("vanilla"),
                List.of(
                        "custom_builtin_spoof",
                        "minecart_improvements",
                        "redstone_experiments",
                        "trade_rebalance",
                        "vanilla")));
    }

    @Test
    void loadableDatapackDirectoryMustRemainEmpty() throws IOException {
        Path absent = temporaryDirectory.resolve("absent");
        assertDoesNotThrow(() -> CaptureCoordinator.requireNoLoadableDatapackContent(absent));

        Path empty = temporaryDirectory.resolve("empty");
        Files.createDirectory(empty);
        assertDoesNotThrow(() -> CaptureCoordinator.requireNoLoadableDatapackContent(empty));

        Path archiveDirectory = temporaryDirectory.resolve("archive");
        Files.createDirectory(archiveDirectory);
        Files.writeString(archiveDirectory.resolve("other.zip"), "not even a valid pack");
        assertThrows(
                IOException.class,
                () -> CaptureCoordinator.requireNoLoadableDatapackContent(archiveDirectory));

        Path unsafe = temporaryDirectory.resolve("not-a-directory");
        Files.writeString(unsafe, "unexpected");
        assertThrows(
                IOException.class,
                () -> CaptureCoordinator.requireNoLoadableDatapackContent(unsafe));
    }

    @Test
    void nativePlaceableYawUsesNetworkQuantizationAndActionableDiagnostics() {
        assertEquals(90.0F, ClientFixtureObserver.networkQuantizedYaw(90.0F));
        assertTrue(ClientFixtureObserver.entityYawMatches(90.0F, 90.0F));
        assertFalse(ClientFixtureObserver.entityYawMatches(0.0F, 90.0F));

        String message = ClientFixtureObserver.entityYawMismatch(0.0F, 90.0F);
        assertTrue(message.contains("actual=0.0"));
        assertTrue(message.contains("expectedRaw=90.0"));
        assertTrue(message.contains("expectedNetwork=90.0"));
    }

    @Test
    void studioScaleReferenceIsTheFixedTwoMeterFloorRuler() {
        CapturePlan.StudioScaleReference reference = new CapturePlan.StudioScaleReference(
                "ordinary_block_floor_ruler",
                new CapturePlan.BlockPosition(-2, 79, 7),
                2,
                new CapturePlan.BlockStateSpec("minecraft:black_concrete", java.util.Map.of()),
                new CapturePlan.BlockStateSpec("minecraft:white_concrete", java.util.Map.of()));

        assertEquals(
                List.of(new BlockPos(-2, 79, 7), new BlockPos(-1, 79, 7)),
                CaptureCoordinator.scaleReferencePositions(reference));
    }
}
