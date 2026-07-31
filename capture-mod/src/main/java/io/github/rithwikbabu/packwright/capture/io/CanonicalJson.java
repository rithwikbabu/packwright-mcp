package io.github.rithwikbabu.packwright.capture.io;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.nio.charset.StandardCharsets;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Packwright canonical JSON: sorted object keys, compact values, and one trailing newline. */
public final class CanonicalJson {
    // JavaScript's JSON.stringify, which owns the TypeScript wire format, does not
    // perform HTML escaping. Gson's default \u003d/\u003c/\u003e escapes would change
    // every plan/report hash that contains declarative component syntax.
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
        } else if (value.isNumber()) {
            output.append(formatEcmaNumber(value.getAsDouble()));
        } else {
            output.append(value);
        }
    }

    /** Matches the finite-number spelling used by ECMAScript JSON.stringify. */
    static String formatEcmaNumber(double value) {
        if (!Double.isFinite(value)) {
            throw new IllegalArgumentException("Canonical JSON numbers must be finite.");
        }
        if (value == 0.0d) return "0";
        double absolute = Math.abs(value);
        if (absolute >= 1.0e-6 && absolute < 1.0e21) {
            return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
        }
        String raw = Double.toString(value).toLowerCase(java.util.Locale.ROOT);
        int exponentIndex = raw.indexOf('e');
        if (exponentIndex < 0) return raw;
        String mantissa = raw.substring(0, exponentIndex);
        if (mantissa.endsWith(".0")) mantissa = mantissa.substring(0, mantissa.length() - 2);
        String exponentText = raw.substring(exponentIndex + 1);
        boolean negative = exponentText.startsWith("-");
        if (negative || exponentText.startsWith("+")) exponentText = exponentText.substring(1);
        int firstDigit = 0;
        while (firstDigit + 1 < exponentText.length()
                && exponentText.charAt(firstDigit) == '0') firstDigit++;
        exponentText = exponentText.substring(firstDigit);
        return mantissa + 'e' + (negative ? "-" : "+") + exponentText;
    }
}
