package io.github.rithwikbabu.packwright.capture.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.StringReader;
import java.math.BigDecimal;
import java.util.HashSet;
import java.util.Set;

/** Strict JSON reader which rejects duplicate object keys instead of silently replacing them. */
final class StrictJson {
    private StrictJson() {}

    static JsonObject parseObject(String text) throws ProtocolException {
        try (JsonReader reader = new JsonReader(new StringReader(text))) {
            reader.setStrictness(Strictness.STRICT);
            JsonElement root = read(reader);
            if (reader.peek() != JsonToken.END_DOCUMENT) {
                throw new ProtocolException("Capture plan contains trailing JSON content.");
            }
            if (!root.isJsonObject()) {
                throw new ProtocolException("Capture plan root must be a JSON object.");
            }
            return root.getAsJsonObject();
        } catch (ProtocolException error) {
            throw error;
        } catch (IOException | IllegalStateException | NumberFormatException error) {
            throw new ProtocolException("Capture plan is not strict JSON.", error);
        }
    }

    private static JsonElement read(JsonReader reader) throws IOException, ProtocolException {
        return switch (reader.peek()) {
            case BEGIN_OBJECT -> readObject(reader);
            case BEGIN_ARRAY -> readArray(reader);
            case STRING -> new JsonPrimitive(reader.nextString());
            case NUMBER -> new JsonPrimitive(new BigDecimal(reader.nextString()));
            case BOOLEAN -> new JsonPrimitive(reader.nextBoolean());
            case NULL -> {
                reader.nextNull();
                yield JsonNull.INSTANCE;
            }
            default -> throw new ProtocolException("Capture plan contains an unexpected JSON token.");
        };
    }

    private static JsonObject readObject(JsonReader reader) throws IOException, ProtocolException {
        JsonObject result = new JsonObject();
        Set<String> names = new HashSet<>();
        reader.beginObject();
        while (reader.hasNext()) {
            String name = reader.nextName();
            if (!names.add(name)) {
                throw new ProtocolException("Capture plan contains duplicate key: " + name);
            }
            result.add(name, read(reader));
        }
        reader.endObject();
        return result;
    }

    private static JsonArray readArray(JsonReader reader) throws IOException, ProtocolException {
        JsonArray result = new JsonArray();
        reader.beginArray();
        while (reader.hasNext()) {
            result.add(read(reader));
        }
        reader.endArray();
        return result;
    }
}
