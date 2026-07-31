package io.github.rithwikbabu.packwright.capture.io;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class CanonicalJsonTest {
    @Test
    void sortsNestedObjectKeysWithoutChangingArrayOrder() {
        byte[] encoded = CanonicalJson.encode(Map.of(
                "z", List.of(2, 1),
                "a", Map.of("y", true, "b", "text")));

        assertEquals(
                "{\"a\":{\"b\":\"text\",\"y\":true},\"z\":[2,1]}\n",
                new String(encoded, StandardCharsets.UTF_8));
    }

    @Test
    void spellsNumbersLikeJavascriptJsonStringify() {
        assertEquals(
                "{\"large\":1e+21,\"minPlain\":0.000001,\"negativeZero\":0,\"small\":1e-7,\"whole\":1}\n",
                new String(CanonicalJson.encode(Map.of(
                        "whole", 1.0,
                        "negativeZero", -0.0,
                        "minPlain", 1.0e-6,
                        "small", 1.0e-7,
                        "large", 1.0e21)), StandardCharsets.UTF_8));
    }
}
