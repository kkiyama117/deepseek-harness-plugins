/** Kernel-isolated commands in the actual development project, without home/store access. */
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { AutomationError } from './automation-client.mjs';
export function inside(root, path) { const value = relative(root, path); return value === '' || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value)); }
export async function sandboxCommand(command, projectRoot, artifactRoot) {
  if (process.platform !== 'linux' || !artifactRoot) throw new AutomationError('COMMAND_ISOLATION_REQUIRED');
  const root = await realpath(projectRoot);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const artifacts = await realpath(artifactRoot);
  if (root === '/' || root === '/home' || root === '/data' || root === '/tmp' || inside('/data/references', root)) throw new AutomationError('INVALID_DEVELOPMENT_ROOT');
  const home = join(artifacts, 'home'); const cache = join(artifacts, 'cache');
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(cache, { recursive: true, mode: 0o700 });
  try { if (!(await stat('/usr/bin/bwrap')).isFile()) throw new Error(); } catch { throw new AutomationError('COMMAND_ISOLATION_UNAVAILABLE'); }
  const args = ['--unshare-pid', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc'];
  for (const path of ['/bin','/sbin','/lib','/lib64']) {
    try { const actual = await realpath(path); if (inside('/usr', actual)) args.push('--symlink', relative('/', actual), path); else args.push('--ro-bind', actual, path); } catch {}
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  // Only public toolchain installs and the module cache are exposed from the host home.
  for (const path of ['/home/kiyama/.local/share/mise/installs', '/home/kiyama/go/pkg/mod']) {
    try { const actual = await realpath(path); if ((await stat(actual)).isDirectory()) args.push('--ro-bind', actual, path); } catch {}
  }
  args.push('--bind', root, root, '--bind', artifacts, artifacts, '--chdir', root,
    '--clearenv', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'HOME', home,
    '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin', '--setenv', 'XDG_CACHE_HOME', cache,
    '--setenv', 'GOCACHE', join(cache, 'go-build'), '--setenv', 'GOMODCACHE', '/home/kiyama/go/pkg/mod',
    '--', '/bin/bash', '-c', command);
  return { executable: '/usr/bin/bwrap', args, cwd: root, artifactRoot: artifacts, env: { LANG: 'C.UTF-8' } };
}
