package io.github.rithwikbabu.packwright.capture.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
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
    void acceptsProtocolV3HeldItemAndStableIdentity() throws Exception {
        Map<String, Object> representation = itemRepresentation("held_item");
        Map<String, Object> vanilla = heldScene("first_person_vanilla", true);
        Map<String, Object> scale = heldScene("first_person_scale_reference", false);
        scale.put("presentation", Map.of(
                "referenceArm", true,
                "referenceArmPurpose", "scale_only"));

        CapturePlan plan = CapturePlan.parse(planJson(representation, List.of(scale, vanilla)));

        assertEquals(3, plan.schemaVersion());
        assertEquals("capture-001", plan.execution().executionId());
        assertEquals("minecraft:stick", plan.provenance()
                .representation()
                .state("default")
                .itemStack()
                .itemId());
        assertEquals(plan.provenance().representation().sha256(), plan.provenance().representationSha256());
        assertEquals("player_feet_anchor", plan.scenes().getFirst().cameraPoseSemantics());
        assertTrue(plan.scenes().getFirst().referenceArm());
        assertFalse(plan.scenes().getLast().referenceArm());
        assertEquals(CapturePlan.ViewKind.FIRST_PERSON_VANILLA, plan.scenes().getLast().viewKind());
        assertEquals(64, plan.scenes().getLast().appliedFixtureSha256(
                plan.provenance().representation()).length());
        assertEquals(
                new CapturePlan.BlockPosition(-2, 79, 7),
                plan.studio().scaleReference().origin());
        assertEquals("minecraft:black_concrete", plan.studio().scaleReference().firstBlock().id());
    }

    @Test
    void requiresTheFixedHashBoundOrdinaryBlockFloorRuler() {
        String valid = planJson(
                itemRepresentation("held_item"),
                List.of(heldScene("first_person_vanilla", true)));

        var missing = JsonParser.parseString(valid).getAsJsonObject();
        missing.getAsJsonObject("studio").remove("scaleReference");
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(missing.toString()));

        var substituted = JsonParser.parseString(valid).getAsJsonObject();
        substituted.getAsJsonObject("studio")
                .getAsJsonObject("scaleReference")
                .getAsJsonObject("firstBlock")
                .addProperty("id", "minecraft:stone");
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(substituted.toString()));
    }

    @Test
    void acceptsEveryAdditionalTargetRepresentation() throws Exception {
        CapturePlan block = CapturePlan.parse(planJson(
                blockRepresentation(), List.of(blockScene("block_hero", "three_quarter", 80))));
        assertEquals(CapturePlan.TargetKind.BLOCK, block.provenance().representation().targetKind());
        assertEquals(80, block.scenes().getFirst().fixture().blockPosition().y());

        CapturePlan headwear = CapturePlan.parse(planJson(
                headwearRepresentation(), List.of(
                        headwearArmorStandScene("head_stand_front", "front"),
                        headwearArmorStandScene("head_stand_side", "side"),
                        headwearScene())));
        CapturePlan.Scene playerHeadwear = headwear.scenes().stream()
                .filter(scene -> scene.id().equals("head_steve_front_close"))
                .findFirst()
                .orElseThrow();
        assertEquals("front", playerHeadwear.fixture().viewAngle());
        assertEquals(2.25, playerHeadwear.fixture().cameraDistance());

        CapturePlan entity = CapturePlan.parse(planJson(
                entityRepresentation(), List.of(entityScene())));
        assertEquals(CapturePlan.Capability.REPLACEMENT, entity.provenance().representation().capability());
        assertEquals(0, entity.scenes().getFirst().fixture().angle());

        CapturePlan placeable = CapturePlan.parse(planJson(
                placeableRepresentation(), List.of(placeableScene())));
        assertEquals("corner", placeable.scenes().getFirst().fixture().context());
        assertEquals("floor", placeable.provenance().representation().review()
                .placementStates().getFirst().attachment());
    }

    @Test
    void rejectsHeadwearWithoutMandatoryArmorStandCoreViews() {
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        headwearRepresentation(), List.of(headwearScene()))));

        Map<String, Object> disabled = headwearRepresentation();
        Map<String, Object> review = new LinkedHashMap<>(map(disabled.get("review")));
        review.put("armorStand", false);
        disabled.put("review", review);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(disabled, List.of(
                        headwearArmorStandScene("head_stand_front", "front"),
                        headwearArmorStandScene("head_stand_side", "side"),
                        headwearScene()))));

        Map<String, Object> duplicatedSide = headwearArmorStandScene("head_stand_side", "side");
        duplicatedSide.put(
                "expectedRenderCameraPose", pose(0.5, 80.95, 11.5, 180, 0));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(headwearRepresentation(), List.of(
                        headwearArmorStandScene("head_stand_front", "front"),
                        duplicatedSide,
                        headwearScene()))));
    }

    @Test
    void rejectsAlternateItemStatesAndAuthoritativeBareHeadControls() throws Exception {
        Map<String, Object> item = itemRepresentation("held_item");
        Map<String, Object> itemStates = new LinkedHashMap<>();
        itemStates.put("default", map(item.get("states")).get("default"));
        itemStates.put("proposal", Map.of(
                "itemStack", itemStack("minecraft:stick", Map.of(
                        "minecraft:item_model", "\"arcana:other\""))));
        item.put("states", itemStates);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        item, List.of(heldScene("first_person_vanilla", true)))));

        Map<String, Object> bare = new LinkedHashMap<>(headwearScene());
        bare.put("id", "comparison_reference--head_bare_steve");
        bare.put("baseSceneId", "head_bare_steve");
        bare.put("viewKind", "comparison_reference");
        bare.put("requiredForAuthority", false);
        bare.put("comparisonSceneIds", List.of("head_steve_front_close"));
        Map<String, Object> bareFixture = new LinkedHashMap<>(map(bare.get("fixture")));
        bareFixture.put("subject", "bare_control");
        bare.put("fixture", bareFixture);
        List<Map<String, Object>> validScenes = List.of(
                headwearArmorStandScene("head_stand_front", "front"),
                headwearArmorStandScene("head_stand_side", "side"),
                headwearScene(),
                bare);
        CapturePlan accepted = CapturePlan.parse(planJson(headwearRepresentation(), validScenes));
        assertFalse(accepted.scenes().stream()
                .filter(scene -> scene.fixture().subject().equals("bare_control"))
                .findFirst()
                .orElseThrow()
                .requiredForAuthority());

        Map<String, Object> relabeled = new LinkedHashMap<>(bare);
        relabeled.put("id", "head_bare_steve");
        relabeled.put("viewKind", "minecraft_vanilla");
        relabeled.put("requiredForAuthority", true);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(headwearRepresentation(), List.of(
                        headwearArmorStandScene("head_stand_front", "front"),
                        headwearArmorStandScene("head_stand_side", "side"),
                        headwearScene(),
                        relabeled))));
    }

    @Test
    void requiresElevatedExactDownFacePosition() throws Exception {
        Map<String, Object> down = blockScene("block_face_down", "down", 84);
        down.put("cameraPose", pose(0.5, 82.25, 5.5, 0, -90));
        down.put("expectedRenderCameraPose", pose(0.5, 82.25, 5.5, 0, -90));
        CapturePlan accepted = CapturePlan.parse(planJson(blockRepresentation(), List.of(down)));
        assertEquals(84, accepted.scenes().getFirst().fixture().blockPosition().y());

        Map<String, Object> buried = new LinkedHashMap<>(down);
        Map<String, Object> fixture = new LinkedHashMap<>(map(buried.get("fixture")));
        fixture.put("blockPosition", Map.of("x", 0, "y", 80, "z", 5));
        buried.put("fixture", fixture);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(blockRepresentation(), List.of(buried))));
    }

    @Test
    void rejectsTamperingLegacyVersionsAndUnboundRepresentations() {
        Map<String, Object> representation = itemRepresentation("held_item");
        String valid = planJson(representation, List.of(heldScene("first_person_vanilla", true)));
        var root = JsonParser.parseString(valid).getAsJsonObject();
        root.addProperty("planSha256", "0".repeat(64));
        assertThrows(ProtocolException.class, () -> CapturePlan.parse(root.toString()));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(valid.replace("\"schemaVersion\":3", "\"schemaVersion\":2")));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(valid.replace("hash_bound_not_loaded", "active")));

        Map<String, Object> staleScene = heldScene("first_person_vanilla", true);
        staleScene.put("representationSha256", "8".repeat(64));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(representation, List.of(staleScene))));
    }

    @Test
    void rejectsArbitraryExecutableAndPathFields() {
        Map<String, Object> scene = heldScene("first_person_vanilla", true);
        Map<String, Object> fixture = new LinkedHashMap<>(map(scene.get("fixture")));
        fixture.put("commands", List.of("function evil:run"));
        scene.put("fixture", fixture);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(itemRepresentation("held_item"), List.of(scene))));

        Map<String, Object> state = new LinkedHashMap<>();
        state.put("displayRig", displayRig());
        Map<String, Object> representation = displayPlaceableRepresentation(state);
        Map<String, Object> defaultState = map(map(representation.get("states")).get("default"));
        Map<String, Object> rig = map(defaultState.get("displayRig"));
        Map<String, Object> node = new LinkedHashMap<>(
                map(((List<?>) rig.get("nodes")).getFirst()));
        node.put("function", "evil:run");
        Map<String, Object> poisonedRig = new LinkedHashMap<>(displayRig());
        poisonedRig.put("nodes", List.of(node));
        state.put("displayRig", poisonedRig);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        displayPlaceableRepresentation(state), List.of(displayPlaceableScene()))));
    }

    @Test
    void rejectsIncompletePlaceableMatrixAndFalseAuthority() {
        Map<String, Object> representation = placeableRepresentation();
        Map<String, Object> review = new LinkedHashMap<>(map(representation.get("review")));
        review.put("orientations", List.of("north", "east"));
        representation.put("review", review);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(representation, List.of(placeableScene()))));

        Map<String, Object> debug = new LinkedHashMap<>(entityScene());
        debug.put("id", "debug_hitbox_reference--entity_front");
        debug.put("viewKind", "debug_hitbox_reference");
        debug.put("requiredForAuthority", true);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(entityRepresentation(), List.of(debug))));
    }

    @Test
    void requiresEveryPlaceableSceneToSelectItsExactPlacementState() throws Exception {
        Map<String, Object> representation = representation(
                "placeable",
                "display_rig",
                "simulated",
                Map.of(
                        "east_floor", Map.of("displayRig", displayRig()),
                        "north_floor", Map.of("displayRig", displayRig())));
        representation.put("review", Map.of(
                "orientations", List.of("north", "east"),
                "attachments", List.of("floor"),
                "placementStates", List.of(
                        Map.of(
                                "orientation", "north",
                                "attachment", "floor",
                                "stateId", "north_floor"),
                        Map.of(
                                "orientation", "east",
                                "attachment", "floor",
                                "stateId", "east_floor"))));

        Map<String, Object> eastScene = displayPlaceableScene();
        Map<String, Object> eastFixture = new LinkedHashMap<>(map(eastScene.get("fixture")));
        eastFixture.put("stateId", "east_floor");
        eastFixture.put("orientation", "east");
        eastScene.put("fixture", eastFixture);

        CapturePlan accepted = CapturePlan.parse(planJson(representation, List.of(eastScene)));
        assertEquals("east_floor", accepted.scenes().getFirst().fixture().stateId());
        assertEquals("east", accepted.scenes().getFirst().fixture().orientation());

        Map<String, Object> mismatchedScene = new LinkedHashMap<>(eastScene);
        Map<String, Object> mismatchedFixture = new LinkedHashMap<>(eastFixture);
        mismatchedFixture.put("orientation", "north");
        mismatchedScene.put("fixture", mismatchedFixture);
        ProtocolException error = assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(representation, List.of(mismatchedScene))));
        assertTrue(error.getMessage().contains(
                "state 'east_floor' does not match north/floor; expected state 'north_floor'"));
    }

    @Test
    void injectedEntityScaleMannequinIsSupplementalOnly() throws Exception {
        Map<String, Object> authoritative = entityScene();
        Map<String, Object> augmented = new LinkedHashMap<>(entityScene());
        augmented.put("id", "world_scale_reference--entity_player_scale");
        augmented.put("baseSceneId", "entity_player_scale");
        augmented.put("viewKind", "world_scale_reference");
        augmented.put("requiredForAuthority", false);
        augmented.put("comparisonSceneIds", List.of("entity_front"));
        Map<String, Object> augmentedFixture = new LinkedHashMap<>(map(augmented.get("fixture")));
        augmentedFixture.put("showPlayerScale", true);
        augmented.put("fixture", augmentedFixture);

        CapturePlan accepted = CapturePlan.parse(planJson(
                entityRepresentation(), List.of(authoritative, augmented)));
        assertEquals(CapturePlan.ViewKind.WORLD_SCALE_REFERENCE,
                accepted.scenes().stream()
                        .filter(scene -> scene.fixture().showPlayerScale())
                        .findFirst()
                        .orElseThrow()
                        .viewKind());

        Map<String, Object> mislabeled = new LinkedHashMap<>(authoritative);
        Map<String, Object> mislabeledFixture =
                new LinkedHashMap<>(map(mislabeled.get("fixture")));
        mislabeledFixture.put("showPlayerScale", true);
        mislabeled.put("fixture", mislabeledFixture);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        entityRepresentation(), List.of(mislabeled))));
    }

    @Test
    void bindsEmptySubjectControlBidirectionallyAndHashesItsFixture() throws Exception {
        Map<String, Object> base = blockScene("block_hero", "three_quarter", 80);
        base.put("comparisonSceneIds", List.of("measurement_control--block_hero"));
        Map<String, Object> control = new LinkedHashMap<>(base);
        control.put("id", "measurement_control--block_hero");
        control.put("viewKind", "measurement_control");
        control.put("requiredForAuthority", false);
        control.put("settlingTicks", 0);
        control.put("fixture", Map.of(
                "kind", "measurement_control",
                "targetKind", "block",
                "stateId", "default",
                "control", "empty_subject"));
        control.put("comparisonSceneIds", List.of("block_hero"));

        CapturePlan plan = CapturePlan.parse(planJson(
                blockRepresentation(), List.of(control, base)));
        CapturePlan.Scene parsedControl = plan.scenes().stream()
                .filter(scene -> scene.viewKind() == CapturePlan.ViewKind.MEASUREMENT_CONTROL)
                .findFirst()
                .orElseThrow();
        assertFalse(parsedControl.requiredForAuthority());
        assertEquals("measurement_control", parsedControl.fixture().kind());
        assertEquals(64, parsedControl.appliedFixtureSha256(
                plan.provenance().representation()).length());

        Map<String, Object> unboundBase = new LinkedHashMap<>(base);
        unboundBase.put("comparisonSceneIds", List.of());
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        blockRepresentation(), List.of(control, unboundBase))));

        Map<String, Object> poisonedControl = new LinkedHashMap<>(control);
        poisonedControl.put("presentation", Map.of("showGlint", true));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        blockRepresentation(), List.of(poisonedControl, base))));
    }

    @Test
    void readinessCriticalMeasurementsAreExplicitCalibratedAndAuthoritative() throws Exception {
        Map<String, Object> day = blockScene("block_light_day", "three_quarter", 80);
        Map<String, Object> low = blockScene("block_light_low", "three_quarter", 80);
        low.put("comparisonSceneIds", List.of("block_light_day"));
        Map<String, Object> critical = Map.ofEntries(
                Map.entry("id", "m_block_light_delta"),
                Map.entry("metric", "pairwise_pixel_delta"),
                Map.entry("authority", "client_pixels"),
                Map.entry("unit", "percent"),
                Map.entry("requiredForReadiness", true),
                Map.entry("threshold", Map.of(
                        "comparison", "below", "warning", 0.1, "failure", 0)));
        low.put("measurementIntents", List.of(critical));

        CapturePlan accepted = CapturePlan.parse(planJson(
                blockRepresentation(), List.of(day, low)));
        assertTrue(accepted.scenes().stream()
                .flatMap(scene -> scene.measurementIntents().stream())
                .findFirst()
                .orElseThrow()
                .requiredForReadiness());

        Map<String, Object> missingCriticality = new LinkedHashMap<>(critical);
        missingCriticality.remove("requiredForReadiness");
        Map<String, Object> missingField = new LinkedHashMap<>(low);
        missingField.put("measurementIntents", List.of(missingCriticality));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        blockRepresentation(), List.of(day, missingField))));

        Map<String, Object> unsupported = new LinkedHashMap<>(critical);
        unsupported.put("metric", "frame_retention");
        Map<String, Object> unsupportedScene = new LinkedHashMap<>(low);
        unsupportedScene.put("measurementIntents", List.of(unsupported));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        blockRepresentation(), List.of(day, unsupportedScene))));

        Map<String, Object> base = blockScene("block_hero", "three_quarter", 80);
        base.put("comparisonSceneIds", List.of("measurement_control--block_hero"));
        Map<String, Object> controlBound = new LinkedHashMap<>(critical);
        controlBound.put("sourceSceneIds", List.of(
                "block_hero", "measurement_control--block_hero"));
        base.put("measurementIntents", List.of(controlBound));
        Map<String, Object> control = new LinkedHashMap<>(base);
        control.put("id", "measurement_control--block_hero");
        control.put("viewKind", "measurement_control");
        control.put("requiredForAuthority", false);
        control.put("measurementIntents", List.of());
        control.put("fixture", Map.of(
                "kind", "measurement_control",
                "targetKind", "block",
                "stateId", "default",
                "control", "empty_subject"));
        control.put("comparisonSceneIds", List.of("block_hero"));
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        blockRepresentation(), List.of(base, control))));
    }

    @Test
    void rejectsImplicitVariantsAndNonCanonicalPlaceableOrigins() {
        Map<String, Object> implicit = entityRepresentation();
        Map<String, Object> states = new LinkedHashMap<>(map(implicit.get("states")));
        Map<String, Object> state = new LinkedHashMap<>(map(states.get("default")));
        Map<String, Object> entity = new LinkedHashMap<>(map(state.get("entity")));
        entity.remove("variant");
        state.put("entity", entity);
        states.put("default", state);
        implicit.put("states", states);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(implicit, List.of(entityScene()))));

        Map<String, Object> scene = placeableScene();
        Map<String, Object> fixture = new LinkedHashMap<>(map(scene.get("fixture")));
        fixture.put("subjectPosition", Map.of("x", 0, "y", 81, "z", 5));
        scene.put("fixture", fixture);
        assertThrows(
                ProtocolException.class,
                () -> CapturePlan.parse(planJson(
                        placeableRepresentation(), List.of(scene))));
    }

    @Test
    void planHashExcludesOnlyExecutionAndReadRequiresCanonicalBytes() throws Exception {
        Map<String, Object> representation = itemRepresentation("held_item");
        String original = planJson(representation, List.of(heldScene("first_person_vanilla", true)));
        String moved = original
                .replace("capture-001", "capture-002")
                .replace("packwright-game-001", "packwright-game-002");
        assertEquals(CapturePlan.parse(original).planSha256(), CapturePlan.parse(moved).planSha256());

        Path canonical = Files.writeString(temporaryDirectory.resolve("plan.json"), original);
        CapturePlan.read(canonical);
        Path whitespace = Files.writeString(temporaryDirectory.resolve("bad.json"), original + '\n');
        assertTrue(assertThrows(ProtocolException.class, () -> CapturePlan.read(whitespace))
                .getMessage()
                .contains("canonical JSON"));
    }

    private static Map<String, Object> heldScene(String viewKind, boolean authoritative) {
        String base = "first_person_right";
        Map<String, Object> scene = baseScene(
                viewKind + "--" + base,
                base,
                "held_item",
                viewKind,
                authoritative,
                "first_person",
                "world",
                pose(0.5, 82.25, 0.5, 0, 0),
                pose(0.5, 83.87, 0.5, 0, 0),
                Map.of("kind", "item_stack", "stateId", "default"));
        scene.put("animationState", "idle");
        return scene;
    }

    private static Map<String, Object> blockScene(String id, String orientation, int y) {
        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("kind", "native_block_state");
        fixture.put("stateId", "default");
        fixture.put("layout", "single");
        fixture.put("backdrop", "studio");
        fixture.put("overlapCopies", 1);
        fixture.put("orientation", orientation);
        fixture.put("animationTick", 0);
        fixture.put("blockPosition", Map.of("x", 0, "y", y, "z", 5));
        return baseScene(
                id,
                id,
                "block",
                "minecraft_vanilla",
                true,
                "neutral",
                "world",
                pose(0.5, 82.25, 0.5, 0, 14),
                pose(0.5, 82.25, 0.5, 0, 14),
                fixture);
    }

    private static Map<String, Object> headwearScene() {
        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("kind", "equippable_head");
        fixture.put("stateId", "default");
        fixture.put("subject", "player");
        fixture.put("framing", "head");
        fixture.put("pose", "idle");
        fixture.put("subjectYaw", 0);
        fixture.put("viewAngle", "front");
        fixture.put("cameraDistance", 2.25);
        fixture.put("chestArmor", false);
        return baseScene(
                "head_steve_front_close",
                "head_steve_front_close",
                "headwear",
                "minecraft_vanilla",
                true,
                "third_person_front",
                "world",
                pose(0.5, 80, 5.5, 0, 0),
                pose(0.5, 81.62, 7.75, 180, 0),
                fixture);
    }

    private static Map<String, Object> headwearArmorStandScene(String id, String viewAngle) {
        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("kind", "equippable_head");
        fixture.put("stateId", "default");
        fixture.put("subject", "armor_stand");
        fixture.put("framing", "full_body");
        fixture.put("pose", "idle");
        fixture.put("subjectYaw", 0);
        fixture.put("viewAngle", viewAngle);
        fixture.put("cameraDistance", 6);
        fixture.put("chestArmor", false);
        Map<String, Object> renderCamera = viewAngle.equals("front")
                ? pose(0.5, 80.95, 11.5, 180, 0)
                : pose(-5.5, 80.95, 5.5, -90, 0);
        return baseScene(
                id,
                id,
                "headwear",
                "minecraft_vanilla",
                true,
                "neutral",
                "world",
                pose(0.5, 80, 5.5, 0, 0),
                renderCamera,
                fixture);
    }

    private static Map<String, Object> entityScene() {
        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("kind", "native_entity");
        fixture.put("stateId", "default");
        fixture.put("pose", "idle");
        fixture.put("angle", 0);
        fixture.put("showPlayerScale", false);
        fixture.put("animationTick", 0);
        return baseScene(
                "entity_front",
                "entity_front",
                "entity",
                "minecraft_vanilla",
                true,
                "neutral",
                "world",
                pose(0.5, 82.25, 0.5, 0, 14),
                pose(0.5, 82.25, 0.5, 0, 14),
                fixture);
    }

    private static Map<String, Object> placeableScene() {
        Map<String, Object> fixture = new LinkedHashMap<>();
        fixture.put("kind", "native_placeable_block");
        fixture.put("stateId", "north_floor");
        fixture.put("orientation", "north");
        fixture.put("attachment", "floor");
        fixture.put("distance", "close");
        fixture.put("occluded", false);
        fixture.put("animationTick", 0);
        fixture.put("context", "corner");
        fixture.put("subjectPosition", Map.of("x", 0, "y", 80, "z", 5));
        return baseScene(
                "place_floor_contact",
                "place_floor_contact",
                "placeable",
                "minecraft_vanilla",
                true,
                "neutral",
                "world",
                pose(0.5, 82.25, 2.25, 0, 14),
                pose(0.5, 82.25, 2.25, 0, 14),
                fixture);
    }

    private static Map<String, Object> displayPlaceableScene() {
        Map<String, Object> scene = placeableScene();
        Map<String, Object> fixture = new LinkedHashMap<>(map(scene.get("fixture")));
        fixture.put("kind", "display_rig");
        fixture.put("targetKind", "placeable");
        scene.put("fixture", fixture);
        scene.put("settlingTicks", 2);
        return scene;
    }

    private static Map<String, Object> baseScene(
            String id,
            String baseId,
            String target,
            String viewKind,
            boolean authoritative,
            String camera,
            String context,
            Map<String, Object> anchor,
            Map<String, Object> renderCamera,
            Map<String, Object> fixture) {
        Map<String, Object> scene = new LinkedHashMap<>();
        scene.put("id", id);
        scene.put("baseSceneId", baseId);
        scene.put("targetKind", target);
        scene.put("representationSha256", "0".repeat(64));
        scene.put("viewKind", viewKind);
        scene.put("requiredForAuthority", authoritative);
        scene.put("camera", camera);
        scene.put("context", context);
        scene.put("hand", "right");
        scene.put("playerModel", "steve");
        scene.put("fov", 70);
        scene.put("resolution", Map.of("width", 1280, "height", 720));
        scene.put("guiScale", 2);
        scene.put("animationState", "idle");
        scene.put("frame", 0);
        scene.put("cameraPoseSemantics", "player_feet_anchor");
        scene.put("cameraPose", anchor);
        scene.put("expectedRenderCameraPose", renderCamera);
        scene.put("environment", Map.of(
                "biome", "minecraft:plains",
                "time", 6000,
                "weather", "clear",
                "lightProfile", "day",
                "skyLight", 15,
                "blockLight", 0,
                "lightSource", Map.of(
                        "level", 0,
                        "offset", Map.of("x", 0, "y", 5, "z", -2))));
        scene.put("settlingTicks", 0);
        scene.put("fixture", fixture);
        scene.put("measurementIntents", List.of());
        scene.put("comparisonSceneIds", List.of());
        return scene;
    }

    private static Map<String, Object> itemRepresentation(String targetKind) {
        return representation(
                targetKind,
                "item_stack",
                "native",
                Map.of("default", Map.of("itemStack", itemStack("minecraft:stick", Map.of(
                        "minecraft:item_model", "\"arcana:firestaff\"")))));
    }

    private static Map<String, Object> blockRepresentation() {
        Map<String, Object> result = representation(
                "block",
                "native_block_state",
                "replacement",
                Map.of("default", Map.of("blockState", blockState("minecraft:stone"))));
        result.put("review", Map.of(
                "transparency", false,
                "biomeTintBiomes", List.of(),
                "animatedTextureTicks", List.of()));
        return result;
    }

    private static Map<String, Object> headwearRepresentation() {
        Map<String, String> components = Map.of(
                "minecraft:equippable", "{slot:\"head\"}");
        Map<String, Object> result = representation(
                "headwear",
                "equippable_head",
                "native",
                Map.of("default", Map.of(
                        "itemStack", itemStack("minecraft:carved_pumpkin", components))));
        result.put("headwear", Map.of("renderMode", "fallback_item"));
        result.put("review", Map.of(
                "wideFov", false,
                "armorStand", true,
                "statePoses", Map.of("default", "idle")));
        return result;
    }

    private static Map<String, Object> entityRepresentation() {
        Map<String, Object> result = representation(
                "entity",
                "native_entity",
                "replacement",
                Map.of("default", Map.of("entity", Map.of(
                        "entityType", "minecraft:wolf",
                        "variant", "minecraft:pale",
                        "baby", false,
                        "equipment", Map.of()))));
        result.put("review", Map.of("lowLight", false, "animationTicks", List.of()));
        return result;
    }

    private static Map<String, Object> placeableRepresentation() {
        Map<String, Object> result = representation(
                "placeable",
                "native_placeable_block",
                "replacement",
                Map.of("north_floor", Map.of(
                        "blockState", blockState(
                                "minecraft:chest", Map.of("facing", "north")))));
        result.put("review", Map.of(
                "orientations", List.of("north"),
                "attachments", List.of("floor"),
                "placementStates", List.of(Map.of(
                        "orientation", "north",
                        "attachment", "floor",
                        "stateId", "north_floor"))));
        return result;
    }

    private static Map<String, Object> displayPlaceableRepresentation(Map<String, Object> state) {
        Map<String, Object> result = representation(
                "placeable", "display_rig", "simulated", Map.of("default", state));
        result.put("review", Map.of(
                "orientations", List.of("north"),
                "attachments", List.of("wall"),
                "placementStates", List.of(Map.of(
                        "orientation", "north",
                        "attachment", "wall",
                        "stateId", "default"))));
        return result;
    }

    private static Map<String, Object> displayRig() {
        return Map.of("nodes", List.of(Map.ofEntries(
                Map.entry("id", "body"),
                Map.entry("kind", "block_display"),
                Map.entry("position", List.of(0, 0, 0)),
                Map.entry("yaw", 0),
                Map.entry("pitch", 0),
                Map.entry("transform", Map.of(
                        "translation", List.of(0, 0, 0),
                        "leftRotation", List.of(0, 0, 0),
                        "scale", List.of(1, 1, 1),
                        "rightRotation", List.of(0, 0, 0))),
                Map.entry("billboard", "fixed"),
                Map.entry("brightness", Map.of("block", 15, "sky", 15)),
                Map.entry("shadow", Map.of("radius", 0.5, "strength", 1)),
                Map.entry("interpolation", Map.of("duration", 0, "startDelta", 0)),
                Map.entry("blockState", blockState("minecraft:stone")))));
    }

    private static Map<String, Object> representation(
            String targetKind, String strategy, String capability, Map<String, Object> states) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("targetKind", targetKind);
        result.put("strategy", strategy);
        result.put("capability", capability);
        result.put("states", states);
        return result;
    }

    private static Map<String, Object> itemStack(
            String itemId, Map<String, String> components) {
        return Map.of(
                "itemId", itemId,
                "count", 1,
                "components", components);
    }

    private static Map<String, Object> blockState(String id) {
        return blockState(id, Map.of());
    }

    private static Map<String, Object> blockState(
            String id, Map<String, String> properties) {
        return Map.of("id", id, "properties", properties);
    }

    private static Map<String, Object> pose(
            double x, double y, double z, double yaw, double pitch) {
        return Map.of("x", x, "y", y, "z", z, "yaw", yaw, "pitch", pitch);
    }

    private static String planJson(
            Map<String, Object> representation, List<Map<String, Object>> sceneValues) {
        String representationSha256 = Hashing.sha256(CanonicalJson.encode(representation));
        List<Map<String, Object>> scenes = new ArrayList<>();
        for (Map<String, Object> value : sceneValues) {
            Map<String, Object> scene = new LinkedHashMap<>(value);
            if ("0".repeat(64).equals(scene.get("representationSha256"))) {
                scene.put("representationSha256", representationSha256);
            }
            scenes.add(scene);
        }
        scenes.sort((left, right) -> ((String) left.get("id")).compareTo((String) right.get("id")));

        Map<String, Object> provenance = new LinkedHashMap<>();
        provenance.put("projectId", "fixture");
        provenance.put("runId", HASH_A);
        provenance.put("revisionId", HASH_B);
        provenance.put("specSha256", HASH_C);
        provenance.put("compiledArtifactId", HASH_D);
        provenance.put("proposalArtifactId", HASH_E);
        provenance.put("projectManifestSha256", HASH_F);
        provenance.put("runtimeManifestSha256", "9".repeat(64));
        provenance.put("datapackContentSha256", "0".repeat(64));
        provenance.put("resourcepackContentSha256", "2".repeat(64));
        provenance.put("packActivation", Map.of(
                "datapack", "hash_bound_not_loaded",
                "resourcepack", "active"));
        provenance.put("representation", representation);
        provenance.put("representationSha256", representationSha256);
        provenance.put("client", Map.of("jarSha1", SHA1, "jarSha256", "3".repeat(64)));
        provenance.put("captureMod", Map.of(
                "id", "packwright_capture",
                "version", "0.5.0-dev",
                "sha256", "4".repeat(64)));

        Map<String, Object> stable = new LinkedHashMap<>();
        stable.put("schemaVersion", 3);
        stable.put("kind", "packwright.client-capture-plan");
        stable.put("minecraftVersion", "26.2");
        stable.put("provenance", provenance);
        stable.put("studio", Map.ofEntries(
                Map.entry("preset", "void_matte"),
                Map.entry("rendererBackend", "opengl"),
                Map.entry("renderDistance", 8),
                Map.entry("simulationDistance", 5),
                Map.entry("graphicsMode", "custom"),
                Map.entry("clouds", "off"),
                Map.entry("particles", "minimal"),
                Map.entry("entityShadows", true),
                Map.entry("viewBobbing", false),
                Map.entry("debugUi", false),
                Map.entry("floorBlock", blockState("minecraft:smooth_stone")),
                Map.entry("backdropBlock", blockState("minecraft:light_gray_concrete")),
                Map.entry("scaleReference", Map.ofEntries(
                        Map.entry("kind", "ordinary_block_floor_ruler"),
                        Map.entry("origin", Map.of("x", -2, "y", 79, "z", 7)),
                        Map.entry("lengthBlocks", 2),
                        Map.entry("firstBlock", blockState("minecraft:black_concrete")),
                        Map.entry("secondBlock", blockState("minecraft:white_concrete"))))));
        stable.put("scenes", scenes);
        String planSha256 = Hashing.sha256(CanonicalJson.encode(stable));

        Map<String, Object> plan = new LinkedHashMap<>(stable);
        plan.put("execution", Map.of(
                "executionId", "capture-001",
                "gameDirectory", "/private/tmp/packwright-game-001",
                "outputDirectory", "/private/tmp/packwright-game-001/packwright/output"));
        plan.put("planSha256", planSha256);
        return new String(CanonicalJson.encode(plan), StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }
}
