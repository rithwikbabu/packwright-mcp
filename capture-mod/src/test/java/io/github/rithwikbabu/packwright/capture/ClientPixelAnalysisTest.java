package io.github.rithwikbabu.packwright.capture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

final class ClientPixelAnalysisTest {
    @Test
    void measuresCoverageAndConservativeEdgeRetention() {
        int[] control = new int[36];
        int[] centered = new int[36];
        centered[3 * 6 + 3] = 1;
        var centeredMask = ClientPixelAnalysis.compare(centered, control, 6, 6);
        assertEquals(1.0 / 36.0, centeredMask.coverageRatio());
        assertEquals(100.0, centeredMask.frameRetentionPercent());

        int[] edge = centered.clone();
        edge[0] = 1;
        var edgeMask = ClientPixelAnalysis.compare(edge, control, 6, 6);
        assertEquals(2.0 / 36.0, edgeMask.coverageRatio());
        assertEquals(50.0, edgeMask.frameRetentionPercent());
    }

    @Test
    void rejectsMismatchedFramebufferDimensions() {
        assertThrows(
                IllegalArgumentException.class,
                () -> ClientPixelAnalysis.compare(new int[3], new int[3], 2, 2));
    }

    @Test
    void measuresLuminanceRetentionAndDebugOverlayProxies() {
        int width = 5;
        int height = 5;
        int[] empty = new int[25];
        int[] visible = new int[25];
        visible[12] = 0x00ffffff;
        visible[13] = 0x00ffffff;
        int[] occluded = visible.clone();
        occluded[13] = 0;
        assertEquals(
                50.0,
                ClientPixelAnalysis.retainedSubjectPercent(
                        occluded, visible, empty, width, height));
        assertEquals(
                2.0 / 25.0 * 100.0,
                ClientPixelAnalysis.changedPercent(visible, empty, width, height));
        assertEquals(
                2.0 / 25.0 * 100.0,
                ClientPixelAnalysis.meanAbsoluteLuminanceDeltaPercent(
                        visible, empty, width, height),
                0.000_001);

        int[] debug = visible.clone();
        for (int x = 1; x <= 3; x++) {
            debug[1 * width + x] = 0x0000ff00;
            debug[3 * width + x] = 0x0000ff00;
        }
        for (int y = 1; y <= 3; y++) {
            debug[y * width + 1] = 0x0000ff00;
            debug[y * width + 3] = 0x0000ff00;
        }
        var qa = ClientPixelAnalysis.hitboxQa(debug, visible, empty, width, height);
        assertEquals(100.0, qa.containmentPercent());
        assertEquals(7.0 / 9.0 * 100.0, qa.emptySpacePercent(), 0.000_001);
        assertEquals(7.0, qa.footprintDeltaPixels());
    }
}
