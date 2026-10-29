"""Copy a DSH recovery home without links back into its replaceable live profile."""
import os
from pathlib import Path
import shutil


def copy_recovery_home(source: Path, destination: Path):
    shutil.copytree(source, destination, symlinks=True,
                    ignore=lambda path, names: {'backups', 'cache', 'reports'} if Path(path) == source else set())
    old_prefix = str(source) + '/'
    for directory, dirs, files in os.walk(destination, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                target = os.readlink(path)
                if target == str(source) or target.startswith(old_prefix):
                    path.unlink()
                    path.symlink_to(str(destination) + target[len(str(source)):])
    # Logs and credentials retain their exact bytes. Only composition paths change.
    configs = [destination / 'cordis.patch.yml']
    for parent in ['profiles', '.agent-presets']:
        for folder in (destination / parent).iterdir():
            if not folder.is_dir() or folder.is_symlink():
                continue
            configs.extend(folder.glob('*.yml'))
            configs.extend(folder.glob('*.yaml'))
            configs.extend(folder.glob('package.json'))
    for path in configs:
        if path.is_file() and not path.is_symlink():
            text = path.read_text()
            changed = text.replace(old_prefix, str(destination) + '/')
            if changed != text:
                path.write_text(changed)
