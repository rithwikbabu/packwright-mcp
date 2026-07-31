package io.github.rithwikbabu.packwright.capture.io;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

public final class Hashing {
    private Hashing() {}

    public static String sha256(byte[] bytes) {
        return HexFormat.of().formatHex(digest().digest(bytes));
    }

    public static String sha256(Path path, long maximumBytes) throws IOException {
        long size = Files.size(path);
        if (size < 0 || size > maximumBytes) throw new IOException("File exceeds capture hash limit.");
        MessageDigest digest = digest();
        byte[] buffer = new byte[64 * 1024];
        long read = 0;
        try (InputStream input = Files.newInputStream(path)) {
            int count;
            while ((count = input.read(buffer)) >= 0) {
                read += count;
                if (read > maximumBytes) throw new IOException("File exceeds capture hash limit.");
                digest.update(buffer, 0, count);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new AssertionError("SHA-256 is required by the Java runtime.", error);
        }
    }
}
