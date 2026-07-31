package io.github.rithwikbabu.packwright.capture.io;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

public record PngEvidence(int width, int height, long size, String sha256) {
    private static final byte[] SIGNATURE = {
        (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    };
    private static final long MAX_PNG_BYTES = 64L * 1024 * 1024;

    public static PngEvidence inspect(Path path) throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path)) {
            throw new IOException("Screenshot is not a regular file.");
        }
        long size = Files.size(path);
        if (size < 24 || size > MAX_PNG_BYTES) throw new IOException("Screenshot PNG size is invalid.");
        byte[] header = new byte[24];
        try (InputStream input = Files.newInputStream(path)) {
            if (input.readNBytes(header, 0, header.length) != header.length) {
                throw new IOException("Screenshot PNG header is truncated.");
            }
        }
        if (!Arrays.equals(SIGNATURE, Arrays.copyOfRange(header, 0, 8))) {
            throw new IOException("Screenshot does not have a PNG signature.");
        }
        if (header[12] != 'I' || header[13] != 'H' || header[14] != 'D' || header[15] != 'R') {
            throw new IOException("Screenshot PNG has no leading IHDR chunk.");
        }
        ByteBuffer dimensions = ByteBuffer.wrap(header, 16, 8).order(ByteOrder.BIG_ENDIAN);
        int width = dimensions.getInt();
        int height = dimensions.getInt();
        if (width <= 0 || height <= 0) throw new IOException("Screenshot PNG dimensions are invalid.");
        return new PngEvidence(width, height, size, Hashing.sha256(path, MAX_PNG_BYTES));
    }
}
