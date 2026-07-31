package io.github.rithwikbabu.packwright.capture;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

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
}
