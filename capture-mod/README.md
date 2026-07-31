# Packwright Capture Mod

This is Packwright's client-only Minecraft 26.2 capture harness. It loads one
strict capture plan, selects an already staged resource pack, waits for the
real client resource reload/model bake and reload overlay to clear, configures
each scene, and captures Minecraft's actual framebuffer through
`Screenshot.grab`.

The mod is deliberately not a general automation or remote-control surface. It:

- supports capture-plan schema version `3` only;
- provides `full` `gui_item` capture plus `limited` one-handed `held_item`,
  block, headwear, allow-listed existing-entity, and native/simulated placeable
  capture; armor, projectile, arbitrary native entity geometry, and
  `twoHanded: true` remain unsupported;
- rejects unknown JSON fields, duplicate keys, unsafe scene IDs, relative or
  symbolic-link protocol paths, unknown resource-pack IDs, and trailing item
  syntax;
- requires Minecraft's built-in offline developer mode;
- never receives account credentials, shell commands, JVM arguments, or an
  arbitrary Minecraft command;
- writes fixed-name PNGs, a canonical `capture-report.json`, and a final
  `capture-complete.json` sentinel atomically, then stops the client;
- writes a failed canonical report plus the same completion sentinel on a
  runtime failure when the validated output directory remains available.

## Build

The project targets Java 25, Minecraft 26.2, Fabric Loader 0.19.3, Fabric Loom
1.17.17, and Gradle 9.5.1. It does not depend on Fabric API.

```sh
./gradlew test build
```

The checked-in wrapper pins Gradle 9.5.1 and verifies the distribution against
its SHA-256 before running the build.

`build/libs/` stays ignored because it is generated. After unit tests and a
reproducible local build, a maintainer copies only the non-sources Packwright
JAR to
`capture-mod/runtime/packwright-capture-mod-0.5.0.jar`. The npm package
allow-lists that exact runtime path; release and ordinary CI do not resolve
Minecraft to rebuild the mod. The TypeScript launcher resolves that exact
filename, verifies its SHA-256, and binds the digest into every capture plan
before staging it in a disposable game directory.

Before updating the runtime JAR, inspect its ZIP entries and verify it contains
only Packwright classes/resources and ordinary JAR metadata. It must not embed
Minecraft classes/assets, Fabric Loader, Fabric API, ASM, Sponge Mixin, Gradle
caches, or client-capture output.

## Launch contract

The orchestrator must create an empty, non-symlink output directory and pass
two absolute, normalized paths:

```text
-Dpackwright.capture.plan=/absolute/path/capture-plan.json
-Dpackwright.capture.output=/absolute/path/output
```

It must launch a disposable 26.2 game directory using the normal manifest
classpath and natives plus Fabric Loader's `KnotClient`, with Minecraft's
fixed `--offlineDeveloperMode`, `--disableMultiplayer`, and `--disableChat`
arguments. It stages the exact resource-pack proposal at
`resourcepacks/packwright-proposal.zip` and the exact datapack proposal only at
the non-loadable provenance path
`packwright/provenance/datapack-proposal.zip`. The datapack archive must never
appear under the disposable world's `datapacks/` directory, be installed, or
be selected. The mod verifies both ZIP hashes, creates the clean world exactly
once with `WorldOpenFlows.createFreshLevel`, rejects the project datapack if it
is available or selected by the integrated server, fixes the world state, then
selects and reloads the staged resource pack.

The plan carries expected Mojang/Fabric/pack hashes and explicit pack-activation
modes (`hash_bound_not_loaded` for the datapack, `active` for the resource
pack) so the surrounding Packwright process can bind the report to artifacts it
verified before launch. The mod independently verifies the launched Minecraft
and Fabric versions, offline mode, both staged archive hashes, absent/unselected
project datapack, selected resource-pack ID, item parser result, framebuffer
PNGs, and screenshot hashes. Its final report attests the activation modes,
archive paths and hashes, and selected pack IDs.

## Capture plan v3

The authoritative schema and identity algorithms live in
`src/minecraft/client-capture-protocol.ts`. The mod accepts its canonical JSON
encoding exactly: `schemaVersion`, `kind`, `minecraftVersion`, `provenance`,
sorted `scenes`, `execution`, and `planSha256`. Provenance binds the project,
revision, compiled proposal, both pack archives, exact tagged representation,
the fixed pack-activation modes, complete runtime manifest, client JAR, and
capture-mod identities. Scenes bind
their target and representation hash, strict declarative fixture, studio and
environment settings, camera/context, hand, Steve/Alex model, FOV, resolution,
GUI scale, animation state/frame, settling interval, measurement intents,
`baseSceneId`, `viewKind`, and `requiredForAuthority`. Unknown fields,
duplicate keys, noncanonical bytes, hash mismatches, and execution-path
mismatches are rejected.

The studio identity includes one fixed `ordinary_block_floor_ruler`: exactly two
adjacent ordinary world blocks at `[-2, 79, 7]`, black concrete followed by
white concrete. The mod places the ruler through the integrated server, reads
the resulting block states and baked models back through the live client before
each capture, and records `actualScaleReference` plus its canonical SHA-256 in
every completed view. A missing, substituted, or unrenderable ruler fails the
capture. This ordinary geometry can supply authoritative world-scale context;
it is distinct from the supplemental injected player mannequin.

The representation union accepts an exact item stack with one canonical
proposal-bound rendered state, existing block states,
simulated block displays, actually equipped head items, allow-listed existing
entities and variants/equipment, native placeables, and strict declarative
display/interaction rigs. Display nodes are static in protocol v3; nonzero
interpolation and block atlas-phase requests are rejected. Simulated entity
rigs provide separate exact `idle`, `walk`, and `attack` states instead of
claiming tick-driven animation. No representation accepts commands,
functions, saves, arbitrary NBT, paths, extra mods, credentials, or executable
content.

Every `equippable_head` representation sets `review.armorStand: true` and must
contain both `head_stand_front` and `head_stand_side` as required authoritative
world scenes. The parser rejects an omitted flag, `false`, a missing scene, or a
scene with the wrong subject, framing, view angle, or canonical camera binding.

The project datapack archive remains provenance-only. Before world creation,
after the integrated server starts, and again when final evidence is written,
the mod requires an empty non-symlink
`saves/packwright-capture/datapacks/` directory, exactly `vanilla` selected, and
exactly the fixed Minecraft 26.2 built-in datapack availability set. It rejects
every selected `file/` datapack, unexpected or missing available pack, and any
loadable filesystem content instead of weakening the isolation attestation.

Every required first-person world scene is `first_person_vanilla`. It uses the
exact stock Minecraft gameplay composition and forbids Packwright's reference
arm fields. These scenes carry the authoritative evidence requirement.

When the caller explicitly requests scale references, the plan includes a
paired `first_person_scale_reference` scene for an existing vanilla scene.
Only this supplemental scene requires signed `referenceArm: true` and
`referenceArmPurpose: "scale_only"` presentation fields. Minecraft 26.2's
generic nonempty-item path can omit the player arm, so the capture mixin
submits that arm through Minecraft's own `ItemInHandRenderer` after the vanilla
item submission and reports whether the submission occurred. This
Minecraft-rendered augmentation supplies QA-only scale and occlusion context;
it is never stock or WYSIWYG gameplay evidence and does not prove that the palm
meets the semantic `primaryGrip`. It cannot replace its paired required vanilla
scene, and it changes only review evidence, never either pack. CPU review
retains the advisory grip-distance measurement; all client frames require
visual review.

Successful execution writes sorted framebuffer PNGs, the full hashed client
log, canonical `capture-report.json`, and finally canonical
`capture-complete.json`. The completion file is the atomic publication point.

Stock `minecraft_vanilla` and `first_person_vanilla` screenshots are
authoritative evidence for the reported OS/GPU/driver and graphics backend.
Optional `first_person_scale_reference`, entity/placeable
`debug_hitbox_reference`, bare-head/injected-comparison, and non-ordinary scale-aid
screenshots have only `augmented_qa_reference` authority and live in a
separate supplemental sheet. In particular, the entity profile's
`entity_player_scale` mannequin is a `world_scale_reference`, is always
supplemental, and can never satisfy capture authority. Client screenshots are
not guaranteed to be pixel-identical on another GPU or operating system. Packwright must retain its
deterministic software preview as a fast, portable advisory first gate.
Protocol success means the required planned evidence completed and verified;
it is not aesthetic approval.

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR
MICROSOFT.
