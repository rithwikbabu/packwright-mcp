package io.github.rithwikbabu.packwright.capture.io;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.UUID;

public final class AtomicFiles {
    private AtomicFiles() {}

    public static void writeNew(Path destination, byte[] content) throws IOException {
        Path parent = destination.getParent();
        if (parent == null || !Files.isDirectory(parent) || Files.isSymbolicLink(parent)) {
            throw new IOException("Atomic destination parent is unavailable or unsafe.");
        }
        if (Files.exists(destination)) throw new IOException("Atomic destination already exists.");
        Path staging = parent.resolve("." + destination.getFileName() + ".tmp-" + UUID.randomUUID());
        try {
            Files.write(staging, content, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            Files.move(staging, destination, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(staging);
        }
    }

    public static void moveNew(Path source, Path destination) throws IOException {
        if (Files.isSymbolicLink(source) || !Files.isRegularFile(source)) {
            throw new IOException("Screenshot staging file is unavailable or unsafe.");
        }
        if (Files.exists(destination)) throw new IOException("Screenshot destination already exists.");
        Files.move(source, destination, StandardCopyOption.ATOMIC_MOVE);
    }
}
