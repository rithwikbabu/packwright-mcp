package io.github.rithwikbabu.packwright.capture.protocol;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Map;

/** Validated protocol paths supplied only by the Packwright launcher. */
public record CapturePaths(Path plan, Path outputDirectory) {
    public static final String PLAN_PROPERTY = "packwright.capture.plan";
    public static final String OUTPUT_PROPERTY = "packwright.capture.output";

    public static CapturePaths fromSystemProperties() throws ProtocolException {
        return from(Map.of(
                PLAN_PROPERTY, System.getProperty(PLAN_PROPERTY, ""),
                OUTPUT_PROPERTY, System.getProperty(OUTPUT_PROPERTY, "")));
    }

    static CapturePaths from(Map<String, String> properties) throws ProtocolException {
        Path plan = absoluteNormalized(properties.get(PLAN_PROPERTY), PLAN_PROPERTY);
        Path output = absoluteNormalized(properties.get(OUTPUT_PROPERTY), OUTPUT_PROPERTY);

        if (Files.isSymbolicLink(plan) || !Files.isRegularFile(plan, LinkOption.NOFOLLOW_LINKS)) {
            throw new ProtocolException("Capture plan must be an existing regular file.");
        }
        if (Files.isSymbolicLink(output) || !Files.isDirectory(output, LinkOption.NOFOLLOW_LINKS)) {
            throw new ProtocolException("Capture output must be an existing directory.");
        }

        try {
            Path realPlan = plan.toRealPath();
            Path realOutput = output.toRealPath();
            if (realPlan.startsWith(realOutput)) {
                throw new ProtocolException("Capture plan must be outside the output directory.");
            }
            return new CapturePaths(plan, output);
        } catch (IOException error) {
            throw new ProtocolException("Capture protocol paths could not be resolved.", error);
        }
    }

    private static Path absoluteNormalized(String value, String property) throws ProtocolException {
        if (value == null || value.isBlank()) {
            throw new ProtocolException("Missing required system property: " + property);
        }
        Path path;
        try {
            path = Path.of(value);
        } catch (RuntimeException error) {
            throw new ProtocolException("Invalid path in system property: " + property, error);
        }
        if (!path.isAbsolute() || !path.equals(path.normalize())) {
            throw new ProtocolException(property + " must be an absolute, normalized path.");
        }
        return path;
    }

}
