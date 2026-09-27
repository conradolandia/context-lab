import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const fixtures = path.join(__dirname, 'fixtures', 'keywords');
const genPath = path.join(__dirname, '..', '..', 'scripts', 'generate-context-keywords.mjs');

describe('generate-context-keywords', () => {
  it('classifies fixture tables with helper/constant overloading primitives', async () => {
    const mod = await import(pathToFileURL(genPath).href);
    const { generateFromDataDir, KEYWORD_INCLUDES } = mod;
    const { lists, counts } = generateFromDataDir(fixtures);

    assert.equal(counts.constants, 3);
    assert.equal(counts.helpers, 4);
    assert.equal(counts.commands, 3);

    assert.ok(lists.constants.includes('zerocount'));
    assert.ok(lists.helpers.includes('ruledhbox'));
    assert.ok(lists.helpers.includes('hbox'));
    assert.ok(lists.commands.includes('setuphead'));

    // hbox is a helper → removed from primitives (overload)
    assert.equal(lists.primitives.includes('hbox'), false);
    // vbox stays a primitive; normalvbox variant added
    assert.ok(lists.primitives.includes('vbox'));
    assert.ok(lists.primitives.includes('normalvbox'));
    // sharedname in both constants and helpers stays in both lists;
    // TextMate order (constant before helper) decides colour.
    assert.ok(lists.constants.includes('sharedname'));
    assert.ok(lists.helpers.includes('sharedname'));
    // interface also lists hbox; helper still wins by pattern order
    assert.ok(lists.commands.includes('hbox'));

    assert.deepEqual(
      KEYWORD_INCLUDES.map((p: { include: string }) => p.include),
      [
        '#constant',
        '#ifprimitive',
        '#helper',
        '#interface-command',
        '#primitive',
        '#reserved',
        '#user-csname',
      ],
    );
  });

  it('parses SciTE Lua string tables', async () => {
    const mod = await import(pathToFileURL(genPath).href);
    const src = readFileSync(path.join(fixtures, 'scite-context-data-context.lua'), 'utf8');
    const table = mod.parseLuaStringTables(src);
    assert.deepEqual(table.constants, ['zerocount', 'plusone', 'sharedname']);
    assert.ok(table.helpers.includes('ruledhbox'));
  });
});
