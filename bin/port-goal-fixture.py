#!/usr/bin/env python3
"""Migrate the preserved Goal fixture's single-call tool API without changing assertions."""
import argparse
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('fixture', type=Path)
args = parser.parse_args()
text = args.fixture.read_text()
if "import { executeToolFixture }" not in text:
    text = "import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'\nimport * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'\n" + text
text = text.replace("import { createInboxStub }", "import { createInboxStub, unsupportedModel }")
if 'own(await ctx.plugin(NativeToolExecutor))' not in text:
    text = text.replace("own(await ctx.plugin(ToolRuntime))\n", "own(await ctx.plugin(ToolRuntime))\n  own(await ctx.plugin(NativeToolExecutor))\n")
text = text.replace("options: {}, status: 'idle', inbox: createInboxStub()", "options: {}, model: unsupportedModel(), status: 'idle', inbox: createInboxStub()")
text = re.sub(r'\b((?:\w+\.)?ctx)\.tools\.execute\(', r'executeToolFixture(\1, ', text)
args.fixture.write_text(text)
