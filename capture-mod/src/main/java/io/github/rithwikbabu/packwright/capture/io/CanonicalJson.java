package io.github.rithwikbabu.packwright.capture.io;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Packwright canonical JSON: sorted object keys, compact values, and one trailing newline. */
public final class CanonicalJson {
    // JavaScript's JSON.stringify, which owns the TypeScript wire format, does not
    // perform HTML escaping. Gson's default \u003d/\u003c/\u003e escapes would change
    // every plan/report hash that contains a component command.
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private CanonicalJson() {}

    public static byte[] encode(Object value) {
        StringBuilder output = new StringBuilder();
        append(output, GSON.toJsonTree(value));
        output.append('\n');
        return output.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static void append(StringBuilder output, JsonElement value) {
        if (value.isJsonNull()) {
            output.append("null");
        } else if (value.isJsonArray()) {
            appendArray(output, value.getAsJsonArray());
        } else if (value.isJsonObject()) {
            appendObject(output, value.getAsJsonObject());
        } else {
            appendPrimitive(output, value.getAsJsonPrimitive());
        }
    }

    private static void appendArray(StringBuilder output, JsonArray value) {
        output.append('[');
        for (int index = 0; index < value.size(); index++) {
            if (index != 0) output.append(',');
            append(output, value.get(index));
        }
        output.append(']');
    }

    private static void appendObject(StringBuilder output, JsonObject value) {
        output.append('{');
        List<String> names = new ArrayList<>(value.keySet());
        names.sort(Comparator.naturalOrder());
        for (int index = 0; index < names.size(); index++) {
            if (index != 0) output.append(',');
            String name = names.get(index);
            output.append(GSON.toJson(name)).append(':');
            append(output, value.get(name));
        }
        output.append('}');
    }

    private static void appendPrimitive(StringBuilder output, JsonPrimitive value) {
        if (value.isString()) {
            output.append(GSON.toJson(value.getAsString()));
        } else {
            output.append(value);
        }
    }
}
