package io.github.rithwikbabu.packwright.capture.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.github.rithwikbabu.packwright.capture.PackwrightCaptureClient;
import io.github.rithwikbabu.packwright.capture.io.CanonicalJson;
import io.github.rithwikbabu.packwright.capture.io.Hashing;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Immutable implementation of Packwright client-capture protocol version 1. */
public record CapturePlan(
        int schemaVersion,
        String kind,
        String minecraftVersion,
        Provenance provenance,
        List<Scene> scenes,
        Execution execution,
        String planSha256) {
    public static final int MAX_PLAN_BYTES = 1_048_576;
    private static final int MAX_SCENES = 32;
    private static final int MAX_ITEM_COMMAND_BYTES = 256 * 1024;
    private static final int MAX_COMPONENT_VALUE_BYTES = 128 * 1024;
    private static final int MAX_COMPONENTS_BYTES = 512 * 1024;
    private static final Pattern SAFE_ID = Pattern.compile("[a-z0-9][a-z0-9_-]{0,63}");
    private static final Pattern EXECUTION_ID =
            Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final Pattern RESOURCE_ID =
            Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");
    private static final Pattern MOD_ID = Pattern.compile("[a-z][a-z0-9_-]{1,63}");
    private static final Pattern VERSION = Pattern.compile("[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}");
    private static final Pattern SHA1 = Pattern.compile("[0-9a-f]{40}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    public enum Camera {
        FIRST_PERSON("first_person"),
        THIRD_PERSON_BACK("third_person_back"),
        THIRD_PERSON_FRONT("third_person_front"),
        NEUTRAL("neutral");

        private final String id;

        Camera(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum Context {
        WORLD("world"),
        INVENTORY("inventory"),
        HOTBAR("hotbar"),
        TOOLTIP("tooltip"),
        ITEM_INSPECTION("item_inspection");

        private final String id;

        Context(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum Hand {
        RIGHT("right"),
        LEFT("left");

        private final String id;

        Hand(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum PlayerModel {
        STEVE("steve"),
        ALEX("alex");

        private final String id;

        PlayerModel(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public enum AnimationState {
        IDLE("idle"),
        SWING("swing"),
        USE("use"),
        FIRE("fire"),
        AIM("aim"),
        RELEASE("release"),
        IMPACT("impact");

        private final String id;

        AnimationState(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public record ClientArtifact(String jarSha1, String jarSha256) {}

    public record CaptureMod(String id, String version, String sha256) {}

    public record ItemStackSpec(
            String itemId, int count, String command, Map<String, String> components) {
        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("itemId", itemId);
            result.put("count", count);
            result.put("command", command);
            result.put("components", components);
            return result;
        }
    }

    public record Provenance(
            String projectId,
            String runId,
            String revisionId,
            String specSha256,
            String compiledArtifactId,
            String proposalArtifactId,
            String projectManifestSha256,
            String runtimeManifestSha256,
            String datapackContentSha256,
            String resourcepackContentSha256,
            ItemStackSpec itemStack,
            ClientArtifact client,
            CaptureMod captureMod) {}

    public record Resolution(int width, int height) {}

    /** Null means the optional presentation object was absent; an empty map was present. */
    public record Scene(
            String id,
            Camera camera,
            Context context,
            Hand hand,
            PlayerModel playerModel,
            int fov,
            Resolution resolution,
            int guiScale,
            AnimationState animationState,
            int frame,
            Map<String, Object> presentation) {
        public int width() {
            return resolution.width();
        }

        public int height() {
            return resolution.height();
        }

        public Map<String, Object> toProtocolValue() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", id);
            result.put("camera", camera.id());
            result.put("context", context.id());
            result.put("hand", hand.id());
            result.put("playerModel", playerModel.id());
            result.put("fov", fov);
            result.put("resolution", Map.of("width", width(), "height", height()));
            result.put("guiScale", guiScale);
            result.put("animationState", animationState.id());
            result.put("frame", frame);
            if (presentation != null) result.put("presentation", presentation);
            return result;
        }

        public String sha256() {
            return Hashing.sha256(CanonicalJson.encode(toProtocolValue()));
        }

        public int stackCount(int fallback) {
            if (presentation == null) return fallback;
            Object value = presentation.get("stackCount");
            return value instanceof Integer count ? count : fallback;
        }

        public boolean presentationFlag(String name, boolean fallback) {
            if (presentation == null) return fallback;
            Object value = presentation.get(name);
            return value instanceof Boolean flag ? flag : fallback;
        }

        public Double durabilityFraction() {
            if (presentation == null) return null;
            Object value = presentation.get("durabilityFraction");
            return value instanceof Double fraction ? fraction : null;
        }

        public boolean referenceArm() {
            return presentationFlag("referenceArm", false);
        }

        public String referenceArmPurpose() {
            if (presentation == null) return null;
            Object value = presentation.get("referenceArmPurpose");
            return value instanceof String purpose ? purpose : null;
        }
    }

    public record Execution(String executionId, String gameDirectory, String outputDirectory) {}

    public static CapturePlan read(Path path) throws ProtocolException {
        final byte[] bytes;
        try {
            long size = Files.size(path);
            if (size <= 0 || size > MAX_PLAN_BYTES) {
                throw new ProtocolException("Capture plan must be between 1 byte and 1 MiB.");
            }
            bytes = Files.readAllBytes(path);
        } catch (IOException error) {
            throw new ProtocolException("Capture plan could not be read.", error);
        }
        String text = decodeUtf8(bytes);
        JsonObject root = StrictJson.parseObject(text);
        if (!Arrays.equals(bytes, CanonicalJson.encode(root))) {
            throw new ProtocolException("Capture plan must use canonical JSON encoding.");
        }
        return parseRoot(root);
    }

    public static CapturePlan parse(String text) throws ProtocolException {
        return parseRoot(StrictJson.parseObject(text));
    }

    private static String decodeUtf8(byte[] bytes) throws ProtocolException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException error) {
            throw new ProtocolException("Capture plan must be valid UTF-8.", error);
        }
    }

    private static CapturePlan parseRoot(JsonObject root) throws ProtocolException {
        exactKeys(root, "plan", Set.of(
                "schemaVersion", "kind", "minecraftVersion", "provenance", "scenes",
                "execution", "planSha256"));
        int schemaVersion = integer(root, "schemaVersion", 1, 1);
        String kind = string(root, "kind", 1, 64);
        if (!kind.equals("packwright.client-capture-plan")) {
            throw new ProtocolException("Capture plan kind is unsupported.");
        }
        String minecraftVersion = string(root, "minecraftVersion", 1, 16);
        if (!minecraftVersion.equals("26.2")) {
            throw new ProtocolException("Capture plan must target Minecraft 26.2.");
        }
        Provenance provenance = parseProvenance(object(root, "provenance"));
        List<Scene> scenes = parseScenes(array(root, "scenes"));
        Execution execution = parseExecution(object(root, "execution"));
        String planSha256 = sha256(root, "planSha256");

        JsonObject stable = root.deepCopy();
        stable.remove("execution");
        stable.remove("planSha256");
        String expected = Hashing.sha256(CanonicalJson.encode(stable));
        if (!expected.equals(planSha256)) {
            throw new ProtocolException("Capture plan hash does not match its stable identity.");
        }

        return new CapturePlan(
                schemaVersion,
                kind,
                minecraftVersion,
                provenance,
                List.copyOf(scenes),
                execution,
                planSha256);
    }

    private static Provenance parseProvenance(JsonObject value) throws ProtocolException {
        exactKeys(value, "provenance", Set.of(
                "projectId", "runId", "revisionId", "specSha256", "compiledArtifactId",
                "proposalArtifactId", "projectManifestSha256", "runtimeManifestSha256",
                "datapackContentSha256", "resourcepackContentSha256", "itemStack", "client",
                "captureMod"));
        String projectId = safeId(value, "projectId");
        String runId = sha256(value, "runId");
        String revisionId = sha256(value, "revisionId");
        String specSha256 = sha256(value, "specSha256");
        String compiledArtifactId = sha256(value, "compiledArtifactId");
        String proposalArtifactId = sha256(value, "proposalArtifactId");
        String projectManifestSha256 = sha256(value, "projectManifestSha256");
        String runtimeManifestSha256 = sha256(value, "runtimeManifestSha256");
        String datapackContentSha256 = sha256(value, "datapackContentSha256");
        String resourcepackContentSha256 = sha256(value, "resourcepackContentSha256");
        ItemStackSpec itemStack = parseItemStack(object(value, "itemStack"));
        ClientArtifact client = parseClient(object(value, "client"));
        CaptureMod captureMod = parseCaptureMod(object(value, "captureMod"));
        return new Provenance(
                projectId,
                runId,
                revisionId,
                specSha256,
                compiledArtifactId,
                proposalArtifactId,
                projectManifestSha256,
                runtimeManifestSha256,
                datapackContentSha256,
                resourcepackContentSha256,
                itemStack,
                client,
                captureMod);
    }

    private static ItemStackSpec parseItemStack(JsonObject value) throws ProtocolException {
        exactKeys(value, "itemStack", Set.of("itemId", "count", "command", "components"));
        String itemId = resourceId(value, "itemId");
        int count = integer(value, "count", 1, 99);
        String command = string(value, "command", 1, MAX_ITEM_COMMAND_BYTES);
        if (command.indexOf('\0') >= 0 || command.indexOf('\n') >= 0 || command.indexOf('\r') >= 0
                || utf8Length(command) > MAX_ITEM_COMMAND_BYTES) {
            throw new ProtocolException("Item command is unsafe or exceeds its byte budget.");
        }
        String prefix = "give @s ";
        String suffix = " " + count;
        if (!command.startsWith(prefix)
                || !command.endsWith(suffix)
                || command.length() <= prefix.length() + suffix.length()) {
            throw new ProtocolException("Item command must use the bounded 'give @s <item> <count>' form.");
        }
        JsonObject componentObject = object(value, "components");
        Map<String, String> components = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : componentObject.entrySet()) {
            if (!RESOURCE_ID.matcher(entry.getKey()).matches()) {
                throw new ProtocolException("Item component key is not a resource identifier.");
            }
            JsonElement element = entry.getValue();
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw new ProtocolException("Item component values must be strings.");
            }
            String component = element.getAsString();
            if (component.indexOf('\0') >= 0 || utf8Length(component) > MAX_COMPONENT_VALUE_BYTES) {
                throw new ProtocolException("Item component value exceeds its byte budget.");
            }
            components.put(entry.getKey(), component);
        }
        if (CanonicalJson.encode(componentObject).length > MAX_COMPONENTS_BYTES) {
            throw new ProtocolException("Item components exceed their byte budget.");
        }
        return new ItemStackSpec(itemId, count, command, Map.copyOf(components));
    }

    private static ClientArtifact parseClient(JsonObject value) throws ProtocolException {
        exactKeys(value, "client", Set.of("jarSha1", "jarSha256"));
        return new ClientArtifact(sha1(value, "jarSha1"), sha256(value, "jarSha256"));
    }

    private static CaptureMod parseCaptureMod(JsonObject value) throws ProtocolException {
        exactKeys(value, "captureMod", Set.of("id", "version", "sha256"));
        String id = string(value, "id", 2, 64);
        String version = string(value, "version", 1, 64);
        if (!MOD_ID.matcher(id).matches()) throw new ProtocolException("captureMod.id is invalid.");
        if (!VERSION.matcher(version).matches()) {
            throw new ProtocolException("captureMod.version is invalid.");
        }
        if (!id.equals(PackwrightCaptureClient.MOD_ID)
                || !version.equals(PackwrightCaptureClient.MOD_VERSION)) {
            throw new ProtocolException("Capture plan requires a different capture-mod identity.");
        }
        return new CaptureMod(id, version, sha256(value, "sha256"));
    }

    private static List<Scene> parseScenes(JsonArray values) throws ProtocolException {
        if (values.isEmpty() || values.size() > MAX_SCENES) {
            throw new ProtocolException("Capture plan must contain between 1 and 32 scenes.");
        }
        List<Scene> scenes = new ArrayList<>();
        String previous = null;
        for (JsonElement element : values) {
            if (!element.isJsonObject()) throw new ProtocolException("Every scene must be an object.");
            Scene scene = parseScene(element.getAsJsonObject());
            if (previous != null && previous.compareTo(scene.id()) >= 0) {
                throw new ProtocolException("Capture scenes must be uniquely sorted by id.");
            }
            previous = scene.id();
            scenes.add(scene);
        }
        return scenes;
    }

    private static Scene parseScene(JsonObject value) throws ProtocolException {
        Set<String> required = Set.of(
                "id", "camera", "context", "hand", "playerModel", "fov", "resolution",
                "guiScale", "animationState", "frame");
        Set<String> actual = value.keySet();
        Set<String> allowed = new HashSet<>(required);
        allowed.add("presentation");
        if (!actual.containsAll(required) || !allowed.containsAll(actual)) {
            throw fieldMismatch("scene", actual, required, allowed);
        }
        String id = safeId(value, "id");
        Camera camera = enumValue(value, "camera", Camera.class);
        Context context = enumValue(value, "context", Context.class);
        Hand hand = enumValue(value, "hand", Hand.class);
        PlayerModel playerModel = enumValue(value, "playerModel", PlayerModel.class);
        int fov = integer(value, "fov", 30, 120);
        JsonObject resolutionObject = object(value, "resolution");
        exactKeys(resolutionObject, "resolution", Set.of("width", "height"));
        int width = integer(resolutionObject, "width", 64, 4096);
        int height = integer(resolutionObject, "height", 64, 4096);
        if ((long) width * height > 16L * 1024 * 1024) {
            throw new ProtocolException("Capture resolution exceeds the pixel budget.");
        }
        int guiScale = integer(value, "guiScale", 0, 8);
        AnimationState animation = enumValue(value, "animationState", AnimationState.class);
        int frame = integer(value, "frame", 0, 72_000);
        Map<String, Object> presentation = value.has("presentation")
                ? parsePresentation(object(value, "presentation"))
                : null;
        boolean requiresReferenceArm = context == Context.WORLD && camera == Camera.FIRST_PERSON;
        boolean hasReferenceArm = presentation != null
                && Boolean.TRUE.equals(presentation.get("referenceArm"));
        boolean hasScaleOnlyPurpose = presentation != null
                && "scale_only".equals(presentation.get("referenceArmPurpose"));
        if (requiresReferenceArm && (!hasReferenceArm || !hasScaleOnlyPurpose)) {
            throw new ProtocolException(
                    "First-person world scenes require referenceArm=true and referenceArmPurpose=scale_only.");
        }
        if (!requiresReferenceArm
                && presentation != null
                && (presentation.containsKey("referenceArm")
                        || presentation.containsKey("referenceArmPurpose"))) {
            throw new ProtocolException(
                    "Reference-arm presentation fields are allowed only for first-person world scenes.");
        }
        return new Scene(
                id,
                camera,
                context,
                hand,
                playerModel,
                fov,
                new Resolution(width, height),
                guiScale,
                animation,
                frame,
                presentation);
    }

    private static Map<String, Object> parsePresentation(JsonObject value) throws ProtocolException {
        Set<String> allowed = Set.of(
                "stackCount", "selectedHotbar", "showGlint", "durabilityFraction",
                "referenceArm", "referenceArmPurpose");
        if (!allowed.containsAll(value.keySet())) {
            throw new ProtocolException("presentation contains an unknown field.");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        if (value.has("stackCount")) {
            result.put("stackCount", integer(value, "stackCount", 1, 99));
        }
        if (value.has("selectedHotbar")) {
            result.put("selectedHotbar", bool(value, "selectedHotbar"));
        }
        if (value.has("showGlint")) result.put("showGlint", bool(value, "showGlint"));
        if (value.has("referenceArm")) {
            result.put("referenceArm", bool(value, "referenceArm"));
        }
        if (value.has("referenceArmPurpose")) {
            String purpose = string(value, "referenceArmPurpose", 1, 32);
            if (!purpose.equals("scale_only")) {
                throw new ProtocolException("referenceArmPurpose must be scale_only.");
            }
            result.put("referenceArmPurpose", purpose);
        }
        if (value.has("durabilityFraction")) {
            result.put("durabilityFraction", decimal(value, "durabilityFraction", 0, 1));
        }
        return Map.copyOf(result);
    }

    private static Execution parseExecution(JsonObject value) throws ProtocolException {
        exactKeys(value, "execution", Set.of("executionId", "gameDirectory", "outputDirectory"));
        String executionId = string(value, "executionId", 1, 128);
        if (!EXECUTION_ID.matcher(executionId).matches()) {
            throw new ProtocolException("executionId contains unsafe characters.");
        }
        String game = hostPath(value, "gameDirectory");
        String output = hostPath(value, "outputDirectory");
        Path gamePath = Path.of(game);
        Path outputPath = Path.of(output);
        if (outputPath.equals(gamePath) || !outputPath.startsWith(gamePath)) {
            throw new ProtocolException("Capture output must be below the disposable game directory.");
        }
        return new Execution(executionId, game, output);
    }

    private static String hostPath(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 1, 4096);
        if (result.indexOf('\0') >= 0 || result.indexOf('\n') >= 0 || result.indexOf('\r') >= 0) {
            throw new ProtocolException(name + " contains an unsafe character.");
        }
        try {
            Path path = Path.of(result);
            if (!path.isAbsolute() || !path.normalize().equals(path) || path.getParent() == null) {
                throw new ProtocolException(name + " must be a canonical absolute host path.");
            }
        } catch (RuntimeException error) {
            throw new ProtocolException(name + " is not a valid host path.", error);
        }
        return result;
    }

    private static int utf8Length(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private static String safeId(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 1, 64);
        if (!SAFE_ID.matcher(result).matches()) {
            throw new ProtocolException(name + " contains unsafe characters.");
        }
        return result;
    }

    private static String resourceId(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 3, 512);
        if (!RESOURCE_ID.matcher(result).matches()) {
            throw new ProtocolException(name + " must be a namespaced resource id.");
        }
        return result;
    }

    private static String sha1(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 40, 40);
        if (!SHA1.matcher(result).matches()) throw new ProtocolException(name + " must be lowercase SHA-1.");
        return result;
    }

    private static String sha256(JsonObject value, String name) throws ProtocolException {
        String result = string(value, name, 64, 64);
        if (!SHA256.matcher(result).matches()) {
            throw new ProtocolException(name + " must be lowercase SHA-256.");
        }
        return result;
    }

    private static JsonObject object(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonObject()) throw new ProtocolException(name + " must be an object.");
        return value.getAsJsonObject();
    }

    private static JsonArray array(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonArray()) throw new ProtocolException(name + " must be an array.");
        return value.getAsJsonArray();
    }

    private static String string(JsonObject parent, String name, int minimum, int maximum)
            throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new ProtocolException(name + " must be a string.");
        }
        String result = value.getAsString();
        if (result.length() < minimum || result.length() > maximum) {
            throw new ProtocolException(name + " has an invalid length.");
        }
        return result;
    }

    private static boolean bool(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
            throw new ProtocolException(name + " must be a boolean.");
        }
        return value.getAsBoolean();
    }

    private static int integer(JsonObject parent, String name, int minimum, int maximum)
            throws ProtocolException {
        BigDecimal number = number(parent, name);
        final int result;
        try {
            result = number.intValueExact();
        } catch (ArithmeticException error) {
            throw new ProtocolException(name + " must be an integer.", error);
        }
        if (result < minimum || result > maximum) throw new ProtocolException(name + " is out of range.");
        return result;
    }

    private static double decimal(JsonObject parent, String name, double minimum, double maximum)
            throws ProtocolException {
        double result = number(parent, name).doubleValue();
        if (!Double.isFinite(result) || result < minimum || result > maximum) {
            throw new ProtocolException(name + " is out of range.");
        }
        return result;
    }

    private static BigDecimal number(JsonObject parent, String name) throws ProtocolException {
        JsonElement value = parent.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException(name + " must be a number.");
        }
        try {
            return value.getAsBigDecimal();
        } catch (NumberFormatException error) {
            throw new ProtocolException(name + " must be a finite JSON number.", error);
        }
    }

    private static <E extends Enum<E>> E enumValue(JsonObject parent, String name, Class<E> type)
            throws ProtocolException {
        String value = string(parent, name, 1, 64).toUpperCase(Locale.ROOT);
        try {
            return Enum.valueOf(type, value);
        } catch (IllegalArgumentException error) {
            throw new ProtocolException(name + " has an unsupported value.", error);
        }
    }

    private static void exactKeys(JsonObject object, String label, Set<String> expected)
            throws ProtocolException {
        if (!object.keySet().equals(expected)) {
            throw fieldMismatch(label, object.keySet(), expected, expected);
        }
    }

    private static ProtocolException fieldMismatch(
            String label, Set<String> actual, Set<String> required, Set<String> allowed) {
        Set<String> missing = new HashSet<>(required);
        missing.removeAll(actual);
        Set<String> unknown = new HashSet<>(actual);
        unknown.removeAll(allowed);
        return new ProtocolException(
                label + " fields mismatch; missing=" + missing + ", unknown=" + unknown + '.');
    }
}
