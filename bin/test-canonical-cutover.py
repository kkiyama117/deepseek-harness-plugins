#!/usr/bin/env python3
"""Exercise readiness and backup helpers without launching or stopping DSH."""
from pathlib import Path
import ast, os, shutil, tempfile, unittest

SCRIPT = Path(__file__).with_name('canonical-cutover.py')

class CutoverTests(unittest.TestCase):
    def test_worker_readiness_waits_for_socket_connection(self):
        tree = ast.parse(SCRIPT.read_text())
        selected = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom)) or isinstance(node, ast.FunctionDef) and node.name == 'worker_ready'], type_ignores=[])
        ns = {}
        exec(compile(selected, str(SCRIPT), 'exec'), ns)
        ready = ns['worker_ready']
        worker = {'updated_at': '2026-10-27T04:51:22Z', 'phase': 'online', 'socket': {'status': 'connected'}, 'last_error': None}
        started_at = ns['datetime'].fromisoformat('2026-10-27T04:51:00+00:00').timestamp()
        cases = [
            ({'socket': 'offline'}, False),
            ({'socket': {'status': 'connecting'}}, False),
            ({'phase': 'starting'}, False),
            ({'last_error': 'SOCKET_FAILED'}, False),
            ({'updated_at': '2026-10-27T04:50:59Z'}, False),
            ({}, True),
        ]
        for changes, expected in cases:
            with self.subTest(changes=changes):
                self.assertEqual(ready(worker | changes, started_at), expected)

    def test_helpers_are_not_shadowed(self):
        tree = ast.parse(SCRIPT.read_text())
        functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
        stores = set()
        def scan(node):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): return
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store): stores.add(node.id)
            for child in ast.iter_child_nodes(node): scan(child)
        scan(tree)
        self.assertFalse(functions & stores)

    def test_restore_replaces_installed_directories_with_original_links(self):
        root = Path(tempfile.mkdtemp(prefix='dsh-cutover-rollback-test-')).resolve()
        try:
            home = root/'home'; home.mkdir()
            external = root/'preserved-source'; external.mkdir(); (external/'marker').write_text('original source')
            for profile in ['web','headless','ai-reference-store-daily']:
                folder = home/'profiles'/profile
                (folder/'node_modules/@local').mkdir(parents=True)
                (folder/'node_modules/@local/pkg').symlink_to(external, target_is_directory=True)
                (folder/'package.json').write_text('{"original":true}\n')
            tree = ast.parse(SCRIPT.read_text())
            selected = ast.Module(body=[node for node in tree.body if isinstance(node,(ast.Import,ast.ImportFrom,ast.FunctionDef))],type_ignores=[])
            ns = {'CORE':root,'HOME':home,'BACKUP':root,'REPORT':root}
            exec(compile(selected,str(SCRIPT),'exec'),ns)
            archive = root/'profiles.tar.zst'
            ns['archive'](home,[Path('profiles')],archive)
            for profile in ['web','headless','ai-reference-store-daily']:
                modules = home/'profiles'/profile/'node_modules'
                self.assertEqual(modules.resolve(),modules)
                shutil.rmtree(modules)
                (modules/'@local/pkg').mkdir(parents=True)
                (modules/'@local/pkg/new-file').write_text('new package')
            ns['restore_profiles'](archive)
            for profile in ['web','headless','ai-reference-store-daily']:
                package = home/'profiles'/profile/'node_modules/@local/pkg'
                self.assertTrue(package.is_symlink())
                self.assertEqual((package/'marker').read_text(),'original source')
            self.assertEqual((external/'marker').read_text(),'original source')
        finally:
            self.assertEqual(root.parent,Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith('dsh-cutover-rollback-test-'))
            self.assertFalse(root.is_symlink())
            shutil.rmtree(root)

if __name__ == '__main__': unittest.main()
