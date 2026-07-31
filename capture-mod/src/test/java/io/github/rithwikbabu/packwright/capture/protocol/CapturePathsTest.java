package io.github.rithwikbabu.packwright.capture.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class CapturePathsTest {
    @TempDir
    Path temporaryDirectory;

    @Test
    void acceptsAbsoluteNormalizedRegularPaths() throws Exception {
        Path root = temporaryDirectory.toRealPath();
        Path plan = Files.writeString(root.resolve("plan.json"), "{}");
        Path output = Files.createDirectory(root.resolve("output"));

        CapturePaths paths = CapturePaths.from(properties(plan, output));

        assertEquals(plan.toRealPath(), paths.plan());
        assertEquals(output.toRealPath(), paths.outputDirectory());
    }

    @Test
    void rejectsRelativeAndNonNormalizedPaths() throws Exception {
        Path root = temporaryDirectory.toRealPath();
        Path plan = Files.writeString(root.resolve("plan.json"), "{}");
        Path output = Files.createDirectory(root.resolve("output"));

        assertThrows(
                ProtocolException.class,
                () -> CapturePaths.from(properties(Path.of("plan.json"), output)));
        assertThrows(
                ProtocolException.class,
                () -> CapturePaths.from(properties(plan, output.resolve("..").resolve("output"))));
    }

    @Test
    void rejectsPlanInsideOutputDirectory() throws Exception {
        Path root = temporaryDirectory.toRealPath();
        Path output = Files.createDirectory(root.resolve("output"));
        Path plan = Files.writeString(output.resolve("plan.json"), "{}");

        assertThrows(ProtocolException.class, () -> CapturePaths.from(properties(plan, output)));
    }

    @Test
    void rejectsSymbolicLinksInEitherPath() throws Exception {
        Path root = temporaryDirectory.toRealPath();
        Path realPlan = Files.writeString(root.resolve("real-plan.json"), "{}");
        Path realOutput = Files.createDirectory(root.resolve("real-output"));
        Path linkedPlan = root.resolve("linked-plan.json");
        Path linkedOutput = root.resolve("linked-output");
        try {
            Files.createSymbolicLink(linkedPlan, realPlan);
            Files.createSymbolicLink(linkedOutput, realOutput);
        } catch (UnsupportedOperationException | IOException error) {
            return;
        }

        assertThrows(ProtocolException.class, () -> CapturePaths.from(properties(linkedPlan, realOutput)));
        assertThrows(ProtocolException.class, () -> CapturePaths.from(properties(realPlan, linkedOutput)));
    }

    private static Map<String, String> properties(Path plan, Path output) {
        return Map.of(
                CapturePaths.PLAN_PROPERTY, plan.toString(),
                CapturePaths.OUTPUT_PROPERTY, output.toString());
    }
}
