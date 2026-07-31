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
}
