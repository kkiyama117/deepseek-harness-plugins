"""Move verified external-package tests into their maintained plugin repository.

Copies first, verifies exact rewritten content, and only then removes the four
explicit temporary test paths and temporary config from the isolated DSH tree.
"""
from pathlib import Path
import sys
root=Path(__file__).resolve().parent.parent
target=Path(sys.argv[1]).resolve()
assert (target/'package.json').is_file()
out=root/'tests/upgrade'
out.mkdir(parents=True,exist_ok=False)
for name in ['local-workflow-results','local-goal-acceptance','local-session-cleanup','local-codex-recovery']:
    path=target/'scripts'/f'{name}.spec.ts'
    assert path.resolve()==target/'scripts'/f'{name}.spec.ts'
    text=path.read_text().replace("'../packages/","'@test-target/packages/")
    text=text.replace(str(root)+'/', '../../')
    dest=out/path.name
    dest.write_text(text)
    assert dest.read_text()==text
    path.unlink()
config=target/'vitest.local-upgrade.config.ts'
assert config.resolve()==target/'vitest.local-upgrade.config.ts'
(root/'tests/upgrade/original-config.txt').write_bytes(config.read_bytes())
config.unlink()
print(out)
