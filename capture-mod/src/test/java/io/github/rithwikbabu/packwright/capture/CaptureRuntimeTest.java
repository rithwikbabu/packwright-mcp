package io.github.rithwikbabu.packwright.capture;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.github.rithwikbabu.packwright.capture.protocol.ProtocolException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class CaptureRuntimeTest {
    @TempDir
    Path temporaryDirectory;

    @Test
    void acceptsOnlyTheReservedEmptyCaptureSaveContainer() throws IOException {
        Path game = createEmptyCaptureSave();

        assertDoesNotThrow(() -> CaptureRuntime.validateCaptureOnlySaves(game));
    }

    @Test
    void rejectsMissingOrAdditionalSaveDirectories() throws IOException {
        Path missing = temporaryDirectory.resolve("missing-capture");
        Files.createDirectories(missing.resolve("saves"));
        assertThrows(
                ProtocolException.class,
                () -> CaptureRuntime.validateCaptureOnlySaves(missing));

        Path additional = createEmptyCaptureSave();
        Files.createDirectory(additional.resolve("saves/user-world"));
        assertThrows(
                ProtocolException.class,
                () -> CaptureRuntime.validateCaptureOnlySaves(additional));
    }

    @Test
    void rejectsAnyPreexistingWorldOrLoadableDatapackContent() throws IOException {
        Path game = createEmptyCaptureSave();
        Path datapacks = game.resolve("saves/packwright-capture/datapacks");
        Files.createDirectory(datapacks);
        Files.writeString(datapacks.resolve("packwright-proposal.zip"), "not a pack");

        assertThrows(
                ProtocolException.class,
                () -> CaptureRuntime.validateCaptureOnlySaves(game));
    }

    @Test
    void rejectsSymbolicSaveBoundaries() throws IOException {
        Path game = temporaryDirectory.resolve("symbolic-save");
        Path external = temporaryDirectory.resolve("external-save");
        Files.createDirectories(game);
        Files.createDirectories(external.resolve("packwright-capture"));
        Files.createSymbolicLink(game.resolve("saves"), external);

        assertThrows(
                ProtocolException.class,
                () -> CaptureRuntime.validateCaptureOnlySaves(game));
    }

    private Path createEmptyCaptureSave() throws IOException {
        Path game = temporaryDirectory.resolve("game");
        Files.createDirectories(game.resolve("saves/packwright-capture"));
        return game;
    }
}
