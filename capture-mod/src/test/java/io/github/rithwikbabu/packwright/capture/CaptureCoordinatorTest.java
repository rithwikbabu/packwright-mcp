package io.github.rithwikbabu.packwright.capture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class CaptureCoordinatorTest {
    private static final String START = "Packwright capture resource reload started";

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
}
