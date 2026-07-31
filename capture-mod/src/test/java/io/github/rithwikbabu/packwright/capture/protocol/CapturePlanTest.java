package io.github.rithwikbabu.packwright.capture.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.rithwikbabu.packwright.capture.io.CanonicalJson;
import io.github.rithwikbabu.packwright.capture.io.Hashing;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class CapturePlanTest {
    private static final String SHA1 = "1".repeat(40);
    private static final String HASH_A = "a".repeat(64);
    private static final String HASH_B = "b".repeat(64);
    private static final String HASH_C = "c".repeat(64);
    private static final String HASH_D = "d".repeat(64);
    private static final String HASH_E = "e".repeat(64);
    private static final String HASH_F = "f".repeat(64);

    @TempDir
    Path temporaryDirectory;

    @Test
    void acceptsTypescriptProtocolShapeAndStableIdentity() throws Exception {
        CapturePlan plan = CapturePlan.parse(
                planJson(List.of(scaleReferenceScene(), worldScene(), inventoryScene())));

        assertEquals("packwright.client-capture-plan", plan.kind());
        assertEquals("capture-001", plan.execution().executionId());
        assertEquals("minecraft:stick", plan.provenance().itemStack().itemId());
        assertEquals("9".repeat(64), plan.provenance().runtimeManifestSha256());
        assertEquals(CapturePlan.Camera.FIRST_PERSON, plan.scenes().getFirst().camera());
        assertTrue(plan.scenes().getFirst().referenceArm());
        assertEquals("scale_only", plan.scenes().getFirst().referenceArmPurpose());
        assertEquals(
                CapturePlan.ViewKind.FIRST_PERSON_SCALE_REFERENCE,
                plan.scenes().getFirst().viewKind());
        assertEquals(
                CapturePlan.ViewKind.FIRST_PERSON_VANILLA,
                plan.scenes().get(1).viewKind());
        assertTrue(plan.scenes().get(1).requiredForAuthority());
        assertEquals(false, plan.scenes().get(1).referenceArm());
        assertEquals(CapturePlan.Context.INVENTORY, plan.scenes().getLast().context());
        assertEquals(64, plan.scenes().getLast().stackCount(1));
        assertEquals(0.5, plan.scenes().getLast().durabilityFraction());
        assertEquals(64, plan.planSha256().length());
    }

    @Test
    void planHashExcludesOnlyExecutionScope() throws Exception {
        String original = planJson(List.of(worldScene()));
        String moved = original
                .replace("capture-001", "capture-002")
                .replace("/private/tmp/packwright-game-001", "/private/tmp/packwright-game-002");

        CapturePlan first = CapturePlan.parse(original);
        CapturePlan second = CapturePlan.parse(moved);

        assertEquals(64, first.planSha256().length());
        assertEquals(first.planSha256(), second.planSha256());
    }

    @Test
    void rejectsTamperedPlanIdentity() {
        String invalid = planJson(List.of(worldScene())).replace(HASH_F, "0".repeat(64));
        ProtocolException error = assertThrows(ProtocolException.class, () -> CapturePlan.parse(invalid));
        assertTrue(error.getMessage().contains("plan hash"));
    }

    @Test
    void rejectsUnknownMissingAndDuplicateFields() {
        String valid = planJson(List.of(worldScene()));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(valid.replace("\"kind\":", "\"shell\":\"rm\",\"kind\":")));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(valid.replace("\"kind\":\"packwright.client-capture-plan\",", "")));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(valid.replace(
                        "\"kind\":\"packwright.client-capture-plan\"",
                        "\"kind\":\"packwright.client-capture-plan\",\"kind\":\"other\"")));
    }

    @Test
    void rejectsUnsortedScenesUnsafeCommandsAndWrongModVersion() {
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(List.of(inventoryScene(), worldScene()))));
        String command = planJson(List.of(worldScene())).replace("give @s ", "kill ");
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(command));
        String version = planJson(List.of(worldScene())).replace("\"version\":\"0.4.1\"", "\"version\":\"0.4.0\"");
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(version));
    }

    @Test
    void rejectsOutputOutsideDisposableGameDirectoryAndResolutionBudget() {
        String escaped = planJson(List.of(worldScene())).replace(
                "/private/tmp/packwright-game-001/packwright/output",
                "/private/tmp/other/output");
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(escaped));

        Map<String, Object> scene = new LinkedHashMap<>(worldScene());
        scene.put("resolution", Map.of("width", 4096, "height", 4097));
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(planJson(List.of(scene))));
    }

    @Test
    void separatesAuthoritativeVanillaFromOptionalScaleReferenceScenes() {
        Map<String, Object> augmentedVanilla = new LinkedHashMap<>(worldScene());
        augmentedVanilla.put(
                "presentation",
                Map.of("referenceArm", true, "referenceArmPurpose", "scale_only"));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(List.of(augmentedVanilla))));

        Map<String, Object> missing = new LinkedHashMap<>(scaleReferenceScene());
        missing.remove("presentation");
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(List.of(missing, worldScene()))));

        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(List.of(scaleReferenceScene()))));

        Map<String, Object> mismatched = new LinkedHashMap<>(scaleReferenceScene());
        mismatched.put("fov", 90);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(List.of(mismatched, worldScene()))));

        Map<String, Object> unexpected = new LinkedHashMap<>(inventoryScene());
        unexpected.put(
                "presentation",
                Map.of("referenceArm", true, "referenceArmPurpose", "scale_only"));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(List.of(unexpected))));
    }

    @Test
    void readRequiresCanonicalUtf8Bytes() throws Exception {
        String canonical = planJson(List.of(worldScene()));
        Path valid = Files.writeString(temporaryDirectory.resolve("valid.json"), canonical);
        CapturePlan.read(valid);

        Path whitespace = Files.writeString(temporaryDirectory.resolve("whitespace.json"), canonical + '\n');
        ProtocolException error = assertThrows(ProtocolException.class, () -> CapturePlan.read(whitespace));
        assertTrue(error.getMessage().contains("canonical JSON"));
    }

    private static Map<String, Object> worldScene() {
        Map<String, Object> scene = new LinkedHashMap<>();
        scene.put("id", "first_person_vanilla--first_person_right");
        scene.put("baseSceneId", "first_person_right");
        scene.put("viewKind", "first_person_vanilla");
        scene.put("requiredForAuthority", true);
        scene.put("camera", "first_person");
        scene.put("context", "world");
        scene.put("hand", "right");
        scene.put("playerModel", "steve");
        scene.put("fov", 70);
        scene.put("resolution", Map.of("width", 1280, "height", 720));
        scene.put("guiScale", 2);
        scene.put("animationState", "aim");
        scene.put("frame", 7);
        return scene;
    }

    private static Map<String, Object> scaleReferenceScene() {
        Map<String, Object> scene = new LinkedHashMap<>(worldScene());
        scene.put("id", "first_person_scale_reference--first_person_right");
        scene.put("viewKind", "first_person_scale_reference");
        scene.put("requiredForAuthority", false);
        scene.put(
                "presentation",
                Map.of("referenceArm", true, "referenceArmPurpose", "scale_only"));
        return scene;
    }

    private static Map<String, Object> inventoryScene() {
        Map<String, Object> scene = new LinkedHashMap<>();
        scene.put("id", "inventory");
        scene.put("baseSceneId", "inventory");
        scene.put("viewKind", "minecraft_vanilla");
        scene.put("requiredForAuthority", true);
        scene.put("camera", "neutral");
        scene.put("context", "inventory");
        scene.put("hand", "left");
        scene.put("playerModel", "alex");
        scene.put("fov", 70);
        scene.put("resolution", Map.of("width", 1280, "height", 720));
        scene.put("guiScale", 4);
        scene.put("animationState", "idle");
        scene.put("frame", 0);
        scene.put("presentation", Map.of(
                "stackCount", 64,
                "selectedHotbar", true,
                "showGlint", true,
                "durabilityFraction", 0.5));
        return scene;
    }

    private static String planJson(List<Map<String, Object>> scenes) {
        Map<String, Object> itemStack = new LinkedHashMap<>();
        itemStack.put("itemId", "minecraft:stick");
        itemStack.put("count", 1);
        itemStack.put(
                "command",
                "give @s minecraft:stick[minecraft:item_model=\"arcana:firestaff\"] 1");
        itemStack.put("components", Map.of("minecraft:item_model", "\"arcana:firestaff\""));

        Map<String, Object> provenance = new LinkedHashMap<>();
        provenance.put("projectId", "firestaff");
        provenance.put("runId", HASH_A);
        provenance.put("revisionId", HASH_B);
        provenance.put("specSha256", HASH_C);
        provenance.put("compiledArtifactId", HASH_D);
        provenance.put("proposalArtifactId", HASH_E);
        provenance.put("projectManifestSha256", HASH_F);
        provenance.put("runtimeManifestSha256", "9".repeat(64));
        provenance.put("datapackContentSha256", "0".repeat(64));
        provenance.put("resourcepackContentSha256", "2".repeat(64));
        provenance.put("itemStack", itemStack);
        provenance.put("client", Map.of("jarSha1", SHA1, "jarSha256", "3".repeat(64)));
        provenance.put("captureMod", Map.of(
                "id", "packwright_capture", "version", "0.4.1", "sha256", "4".repeat(64)));

        Map<String, Object> stable = new LinkedHashMap<>();
        stable.put("schemaVersion", 2);
        stable.put("kind", "packwright.client-capture-plan");
        stable.put("minecraftVersion", "26.2");
        stable.put("provenance", provenance);
        stable.put("scenes", new ArrayList<>(scenes));
        String planSha256 = Hashing.sha256(CanonicalJson.encode(stable));

        Map<String, Object> plan = new LinkedHashMap<>(stable);
        plan.put("execution", Map.of(
                "executionId", "capture-001",
                "gameDirectory", "/private/tmp/packwright-game-001",
                "outputDirectory", "/private/tmp/packwright-game-001/packwright/output"));
        plan.put("planSha256", planSha256);
        return new String(CanonicalJson.encode(plan), StandardCharsets.UTF_8);
    }
}
