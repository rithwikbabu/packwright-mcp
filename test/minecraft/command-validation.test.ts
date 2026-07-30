import { describe, expect, it } from 'vitest';

import type { ReferenceCache } from '../../src/minecraft/cache.js';
import {
  decodeFunctionText,
  extractLogicalCommands,
  parseVanillaCommandDiagnostics,
  suggestIdentifier,
  type LogicalCommand,
} from '../../src/minecraft/command-validation.js';

const referenceCache: ReferenceCache = {
  commands: {
    type: 'root',
    children: {
      effect: {},
      execute: {},
      give: {},
      particle: {},
      say: {},
    },
  },
  registries: {
    'minecraft:attribute': {
      entries: {
        'minecraft:attack_damage': {},
        'minecraft:bounciness': {},
      },
    },
    'minecraft:particle_type': {
      entries: {
        'minecraft:electric_spark': {},
        'minecraft:flame': {},
      },
    },
  },
};

function onlyCommand(content: string, sourcePath: string): LogicalCommand {
  const commands = extractLogicalCommands(content, sourcePath);
  expect(commands).toHaveLength(1);
  const command = commands[0];
  if (command === undefined) throw new Error('Expected one logical command.');
  return command;
}

function vanillaFailure(id: string, message: string, cursor: number): string {
  return [
    `[12:00:00] [ServerMain/ERROR]: Failed to load function ${id}`,
    '\tjava.util.concurrent.CompletionException: java.lang.IllegalArgumentException',
    `\tCaused by: java.lang.IllegalArgumentException: Whilst parsing command on line 1: ${message} at position ${String(cursor)}: ...<--[HERE]`,
  ].join('\n');
}

describe('Minecraft logical command extraction', () => {
  it('handles CRLF, comments, whitespace, continuations, and macros with source mapping', () => {
    const commands = extractLogicalCommands(
      [
        '# ignored heading',
        '',
        '  execute as @s run \\',
        '    say joined',
        '  # ignored comment',
        '$say $(message)',
        'say final',
      ].join('\r\n'),
      'data/spell/function/chain/cast.mcfunction',
    );

    expect(commands).toHaveLength(3);
    expect(commands[0]).toMatchObject({
      command: 'execute as @s run say joined',
      startLine: 2,
      endLine: 3,
      macro: false,
      segments: [
        {
          sourceLine: 2,
          sourceCharacter: 2,
          commandStart: 0,
          text: 'execute as @s run ',
        },
        {
          sourceLine: 3,
          sourceCharacter: 4,
          commandStart: 18,
          text: 'say joined',
        },
      ],
    });
    expect(commands[1]).toMatchObject({
      command: '$say $(message)',
      startLine: 5,
      endLine: 5,
      macro: true,
    });
    expect(commands[2]).toMatchObject({
      command: 'say final',
      startLine: 6,
      endLine: 6,
      macro: false,
    });
  });

  it('preserves a continuation at physical EOF even when the file ends with a newline', () => {
    expect(
      extractLogicalCommands('execute as @s run \\\n', 'data/demo/function/load.mcfunction'),
    ).toMatchObject([
      {
        command: 'execute as @s run \\',
        startLine: 0,
        endLine: 0,
      },
    ]);
  });

  it('resolves continuations before comments and preserves Java whitespace semantics', () => {
    expect(
      extractLogicalCommands('# disabled \\\nelectrify @s\n', 'data/demo/function/load.mcfunction'),
    ).toEqual([]);
    expect(
      extractLogicalCommands('# comment \\\n', 'data/demo/function/load.mcfunction'),
    ).toMatchObject([{ command: '# comment \\', startLine: 0, endLine: 0 }]);

    const commands = extractLogicalCommands(
      '\u00a0say non_breaking\n\ufeffsay bom',
      'data/demo/function/load.mcfunction',
    );
    expect(commands.map((command) => command.command)).toEqual([
      '\u00a0say non_breaking',
      '\ufeffsay bom',
    ]);
    expect(decodeFunctionText(Buffer.from([0xef, 0xbb, 0xbf, 0x73, 0x61, 0x79]))).toBe('\ufeffsay');
  });

  it('marks an oversized command without suppressing later logical commands', () => {
    const commands = extractLogicalCommands(
      `${'a'.repeat(2_000_001)}\nsay later`,
      'data/demo/function/load.mcfunction',
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ exceededLengthLimit: true });
    expect(commands[1]).toMatchObject({
      command: 'say later',
      exceededLengthLimit: false,
    });
  });
});

describe('vanilla command log normalization', () => {
  it('maps the requested particle failure to line 12 with an exact authoritative suggestion', () => {
    const sourcePath = 'data/spell/function/chain/cast.mcfunction';
    const probe = onlyCommand(
      `${'# padding\n'.repeat(11)}particle minecraft:electric ~ ~ ~`,
      sourcePath,
    );
    const diagnostics = parseVanillaCommandDiagnostics(
      vanillaFailure('packwright_test:probe_00000', 'Unknown particle: minecraft:electric', 27),
      new Map([['packwright_test:probe_00000', probe]]),
      referenceCache,
    );

    expect(diagnostics).toEqual([
      {
        engine: 'minecraft',
        authority: 'authoritative',
        severity: 'error',
        code: 'minecraft.command.unknown_particle',
        message: 'Unknown particle `minecraft:electric`',
        path: sourcePath,
        range: {
          start: { line: 11, character: 9 },
          end: { line: 11, character: 27 },
        },
        suggestedFix: 'Did you mean `minecraft:electric_spark`?',
      },
    ]);
  });

  it('collects multiple asynchronously ordered failures and sorts them by source location', () => {
    const attribute = onlyCommand(
      'attribute @s minecraft:bouncyness base get',
      'data/spell/function/stats.mcfunction',
    );
    const command = onlyCommand(
      'exectue as @s run say hi',
      'data/spell/function/chain/cast.mcfunction',
    );
    const log = [
      vanillaFailure(
        'packwright_test:probe_00001',
        "Can't find element 'minecraft:bouncyness' of type 'minecraft:attribute'",
        35,
      ),
      '[12:00:01] [ServerMain/INFO]: Worker output arrived out of source order',
      vanillaFailure(
        'packwright_test:probe_00000',
        'Unknown or incomplete command, see below for error',
        0,
      ),
    ].join('\n');

    const diagnostics = parseVanillaCommandDiagnostics(
      log,
      new Map([
        ['packwright_test:probe_00000', command],
        ['packwright_test:probe_00001', attribute],
      ]),
      referenceCache,
    );

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      code: 'minecraft.command.unknown_command',
      message: 'Unknown command `exectue`',
      path: 'data/spell/function/chain/cast.mcfunction',
      suggestedFix: 'Did you mean `execute`?',
    });
    expect(diagnostics[1]).toMatchObject({
      code: 'minecraft.command.unknown_attribute',
      message: 'Unknown attribute `minecraft:bouncyness`',
      path: 'data/spell/function/stats.mcfunction',
      suggestedFix: 'Did you mean `minecraft:bounciness`?',
    });
  });

  it('uses Brigadier cursor proximity when an invalid token occurs more than once', () => {
    const probe = onlyCommand(
      'execute if entity @e[tag=minecraft:electric] run particle \\\nminecraft:electric ~ ~ ~',
      'data/spell/function/repeated.mcfunction',
    );
    const cursor = probe.command.lastIndexOf('minecraft:electric') + 'minecraft:electric'.length;
    const diagnostics = parseVanillaCommandDiagnostics(
      vanillaFailure('packwright_test:probe_00000', 'Unknown particle: minecraft:electric', cursor),
      new Map([['packwright_test:probe_00000', probe]]),
      referenceCache,
    );

    expect(diagnostics[0]?.range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 18 },
    });
  });
});

describe('identifier suggestions', () => {
  it('uses close target-version identifiers and rejects distant guesses', () => {
    expect(
      suggestIdentifier('minecraft:electric', ['minecraft:flame', 'minecraft:electric_spark']),
    ).toBe('minecraft:electric_spark');
    expect(
      suggestIdentifier('minecraft:bouncyness', [
        'minecraft:attack_damage',
        'minecraft:bounciness',
      ]),
    ).toBe('minecraft:bounciness');
    expect(suggestIdentifier('totally_unrelated', ['execute', 'give', 'particle'])).toBeUndefined();
  });

  it('breaks equally close suggestions deterministically and never suggests the invalid value', () => {
    expect(suggestIdentifier('minecraft:abc', ['minecraft:abd', 'minecraft:aba'])).toBe(
      'minecraft:aba',
    );
    expect(suggestIdentifier('minecraft:abc', ['minecraft:abc'])).toBeUndefined();
  });
});
