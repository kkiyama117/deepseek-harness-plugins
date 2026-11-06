#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Apply one profile or home patch to the live install between probes."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

PROBE_TASK = 'What is 17*23? Reply with only the number.'
PROBES = (
    ('worker', ('ollama-cloud', 'deepseek-v4.1-flash', 'high')),
    ('review', ('openai-codex', 'gpt-6.1-sol', 'high')),
)
NON_PRODUCTION_PROFILES = frozenset({'web'})
SERVICE_PROFILES = (
    ('headless', 'slack-intake-bridge.service'),
    ('web', 'dsh-web-managed.service'),
    ('ai-reference-store-daily', 'ai-reference-store-daily.service'),
)
RESERVED_PROFILE_NAMES = frozenset({'', '.', '..', 'node_modules'})
DEFAULT_RUN_WORKER = '/data/softwares/kstack/skills/kiyama-mode/scripts/run-worker.sh'


class UsageError(Exception):
    """A usage rule rejected the request before anything was read or written."""


class LiveApplyError(Exception):
    """An OSError raised by one named operation between step 2 and step 9."""

    def __init__(self, operation, error):
        super().__init__(f'{operation}: {error}')
        self.operation = operation
        self.error = error


def absolute(value):
    return Path(value).expanduser().absolute()


def retry_seconds(value):
    try:
        seconds = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError('must be a finite number of seconds, at least 0') from None
    if not math.isfinite(seconds) or seconds < 0:
        raise argparse.ArgumentTypeError('must be a finite number of seconds, at least 0')
    return seconds


def probe_timeout_seconds(value):
    try:
        seconds = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError('must be a finite number of seconds, greater than 0') from None
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError('must be a finite number of seconds, greater than 0')
    return seconds


def cli_path(value):
    return value if '/' not in value else str(absolute(value))


def valid_profile_name(name):
    return (name not in RESERVED_PROFILE_NAMES and '/' not in name and '\\' not in name
            and name.lower() != 'desktop')


def route_of(home, target):
    if target == home / 'cordis.patch.yml':
        return 'home-patch', None
    profiles = home / 'profiles'
    if target.name != 'cordis.patch.yml' or target.parent.parent != profiles:
        return None
    name = target.parent.name
    if valid_profile_name(name) and (profiles / name / 'package.json').is_file():
        return 'profile-patch', name
    return None


class Apply:
    def __init__(self, args):
        if args.dsh_home is not None and not args.dsh_home.strip():
            raise UsageError('LIVE_APPLY_USAGE: --dsh-home is empty')
        self.home = home = (absolute(args.dsh_home) if args.dsh_home is not None
                            else absolute(os.environ['DSH_HOME'] if os.environ.get('DSH_HOME', '').strip() else '~/.dsh'))
        self.target = absolute(args.target)
        self.source = absolute(args.source)
        self.record = absolute(args.record)
        self.dsh = cli_path(args.dsh)
        self.run_worker = str(absolute(args.run_worker))
        self.retry_delay = args.retry_delay
        self.probe_timeout = args.probe_timeout
        approval = args.owner_approved.strip() if args.owner_approved else ''
        self.owner_approved = approval or None
        self.route, self.profile = self.check_usage()
        self.production = self.route == 'home-patch' or self.profile not in NON_PRODUCTION_PROFILES
        self.config_profiles = ([self.profile] if self.route == 'profile-patch' else [
            name for name, _ in SERVICE_PROFILES
            if os.path.isfile(home / 'profiles' / name / 'package.json')])
        self.checks = []
        self.new_bytes = None
        self.old_bytes = None
        self.target_mode = None
        self.record_started = False
        self.replaced = False
        self.ever_replaced = False

    def check_usage(self):
        if not self.home.is_dir():
            raise UsageError(f'LIVE_APPLY_USAGE: harness home is not a directory: {self.home}')
        route = route_of(self.home, self.target)
        if route is None:
            raise UsageError(f'LIVE_APPLY_USAGE: target is not a home or profile patch: {self.target}')
        if os.path.islink(self.target):
            raise UsageError(f'LIVE_APPLY_USAGE: target is a symlink: {self.target}')
        if route[0] == 'profile-patch':
            profiles = self.home / 'profiles'
            if os.path.islink(profiles):
                raise UsageError(f'LIVE_APPLY_USAGE: profiles directory is a symlink: {profiles}')
            if os.path.islink(self.target.parent):
                raise UsageError(f'LIVE_APPLY_USAGE: profile directory is a symlink: {self.target.parent}')
        if not (self.home / 'profiles' / 'headless' / 'package.json').is_file():
            raise UsageError(f'LIVE_APPLY_USAGE: probe profile headless does not exist in {self.home}')
        if not self.source.is_file():
            raise UsageError(f'LIVE_APPLY_USAGE: source is not a regular file: {self.source}')
        if Path(os.path.realpath(self.record)).is_relative_to(Path(os.path.realpath(self.home))):
            raise UsageError(f'LIVE_APPLY_USAGE: record directory is inside the harness home: {self.record}')
        if os.path.lexists(self.record) and not (self.record.is_dir() and not any(self.record.iterdir())):
            raise UsageError(f'LIVE_APPLY_USAGE: record directory is not empty: {self.record}')
        return route

    def run(self):
        try:
            try:
                status, code = self.steps()
            except LiveApplyError as error:
                status, code = self.abort(error)
        except KeyboardInterrupt:
            status, code = self.interrupted()
        if status in ('error', 'interrupted') and self.ever_replaced:
            try:
                self.announce_services('LIVE_APPLY_CHECK_SERVICE',
                                       'may have restarted while the new patch was in place')
            except KeyboardInterrupt:
                pass
        return status, code

    def steps(self):
        try:
            self.new_bytes = self.source.read_bytes()
        except OSError as error:
            raise LiveApplyError('read source', error)
        if os.path.lexists(self.target):
            try:
                self.old_bytes = self.target.read_bytes()
                self.target_mode = stat.S_IMODE(os.stat(self.target).st_mode)
            except OSError as error:
                raise LiveApplyError('read target', error)
        if self.old_bytes == self.new_bytes:
            return 'unchanged', 0
        if self.production and self.owner_approved is None:
            print(f'LIVE_APPLY_REFUSED: {self.target} reaches production; '
                  "pass --owner-approved with the owner's approval", file=sys.stderr)
            return 'refused', 3
        self.create_record()
        failed = self.run_phase('before')
        if failed is not None:
            print(f'LIVE_APPLY_PRE_PROBE_FAILED: {failed} failed; the target was not changed',
                  file=sys.stderr)
            return 'pre-probe-failed', 4
        self.replace_target(self.new_bytes, 'write target')
        failed = self.run_phase('after')
        if failed is None:
            self.announce_services('LIVE_APPLY_RESTART_NEEDED', 'reads this patch only at its next start')
            return 'applied', 0
        print(f'LIVE_APPLY_AFTER_PROBE_FAILED: {failed} failed; restoring {self.target}',
              file=sys.stderr)
        self.restore()
        failed = self.run_phase('rollback')
        self.announce_services('LIVE_APPLY_CHECK_SERVICE',
                               'may have restarted while the new patch was in place')
        if failed is None:
            return 'rolled-back', 5
        print('LIVE_APPLY_ROLLBACK_PROBE_FAILED: the live install still fails after the rollback',
              file=sys.stderr)
        return 'rollback-failed', 6

    def interrupted(self):
        if self.replaced:
            try:
                self.restore()
            except LiveApplyError as error:
                if self.old_bytes is None:
                    print(f'LIVE_APPLY_INTERRUPTED: remove {self.target} by hand: {error.error}',
                          file=sys.stderr)
                else:
                    print(f'LIVE_APPLY_INTERRUPTED: restore {self.target} '
                          f'from {self.record}/backup.yml by hand: {error.error}', file=sys.stderr)
            else:
                print(f'LIVE_APPLY_INTERRUPTED: {self.target} was restored', file=sys.stderr)
        elif self.ever_replaced:
            print(f'LIVE_APPLY_INTERRUPTED: {self.target} was already restored', file=sys.stderr)
        else:
            try:
                self.temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            print('LIVE_APPLY_INTERRUPTED: the target was not changed', file=sys.stderr)
        return 'interrupted', 130

    def abort(self, error):
        print(f'live-apply: {error.operation}: {error.error}', file=sys.stderr)
        if self.replaced and error.operation != 'restore target':
            try:
                self.restore()
            except LiveApplyError as restore_error:
                print(f'live-apply: restore target: {restore_error.error}', file=sys.stderr)
        else:
            try:
                self.temp_path.unlink(missing_ok=True)
            except OSError:
                pass
        return 'error', 1

    def announce_services(self, label, detail):
        for service in self.reached_services():
            print(f'{label}: {service} {detail}', file=sys.stderr)

    def reached_services(self):
        return [service for profile, service in SERVICE_PROFILES
                if self.route == 'home-patch' or profile == self.profile]

    @property
    def temp_path(self):
        return self.target.parent / ('.' + self.target.name + '.live-apply-tmp')

    def create_record(self):
        self.record_started = True
        try:
            self.record.mkdir(parents=True, exist_ok=True)
            os.chmod(self.record, 0o700)
        except OSError as error:
            raise LiveApplyError('write record', error)
        self.write_record('source.yml', self.new_bytes)
        if self.old_bytes is None:
            self.write_record('backup-absent', b'')
        else:
            self.write_record('backup.yml', self.old_bytes)

    def write_record(self, name, data):
        path = self.record / name
        try:
            path.write_bytes(data)
            os.chmod(path, 0o600)
        except OSError as error:
            raise LiveApplyError('write record', error)

    def replace_target(self, data, operation):
        temp = self.temp_path
        mode = 0o600 if self.target_mode is None else self.target_mode
        try:
            temp.unlink(missing_ok=True)
            descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(descriptor, view):]
                os.fchmod(descriptor, mode)
            finally:
                os.close(descriptor)
            if operation == 'write target':
                self.replaced = True
                self.ever_replaced = True
            os.replace(temp, self.target)
        except OSError as error:
            raise LiveApplyError(operation, error)

    def restore(self):
        if self.old_bytes is None:
            try:
                self.target.unlink(missing_ok=True)
            except OSError as error:
                raise LiveApplyError('restore target', error)
        else:
            self.replace_target(self.old_bytes, 'restore target')
        self.replaced = False

    def run_phase(self, phase):
        for name in self.config_profiles:
            if not self.config_check(phase, name):
                return f'config-{name}'
        for name, route in PROBES:
            if not self.model_probe(phase, name, route):
                return name
        return None

    def config_check(self, phase, name):
        check = f'config-{name}'
        entry = {'phase': phase, 'name': check, 'attempt': 1}
        if not os.path.isfile(self.home / 'profiles' / name / 'package.json'):
            self.checks.append({**entry, 'ok': False, 'exitCode': None})
            return False
        code, out, err = self.run_child([self.dsh, '--profile', name, '--dump-config'],
                                        cwd=self.home)
        ok = code == 0
        self.checks.append({**entry, 'ok': ok, 'exitCode': code})
        self.write_attempt(phase, check, 1, out, err)
        return ok

    def model_probe(self, phase, name, route):
        attempts = 2 if phase in ('after', 'rollback') else 1
        for attempt in range(1, attempts + 1):
            if self.probe_attempt(phase, name, attempt, route):
                return True
            if attempt < attempts:
                time.sleep(self.retry_delay)
        return False

    def probe_attempt(self, phase, name, attempt, route):
        entry = {'phase': phase, 'name': name, 'attempt': attempt}
        if not os.path.isfile(self.home / 'profiles' / 'headless' / 'package.json'):
            self.checks.append({**entry, 'ok': False, 'exitCode': None})
            return False
        try:
            directory = Path(tempfile.mkdtemp(prefix='live-apply-probe-'))
        except OSError as error:
            raise LiveApplyError('probe directory', error)
        try:
            code, out, err = self.run_child(
                [self.run_worker, '--read-only', str(directory), 'dsh', *route],
                cwd=directory, stdin_bytes=PROBE_TASK.encode('utf-8'))
            try:
                empty = os.listdir(directory) == []
            except OSError:
                empty = False
            ok = code == 0 and out.decode('utf-8', 'replace').strip() == '391' and empty
            self.checks.append({**entry, 'ok': ok, 'exitCode': code})
            self.write_attempt(phase, name, attempt, out, err)
            return ok
        finally:
            already_raising = sys.exc_info()[0] is not None
            try:
                shutil.rmtree(directory)
            except OSError as error:
                if not already_raising:
                    raise LiveApplyError('probe directory', error)

    def write_attempt(self, phase, name, attempt, out, err):
        self.write_record(f'{phase}-{name}-{attempt}.out', out)
        self.write_record(f'{phase}-{name}-{attempt}.err', err)

    def run_child(self, argv, cwd, stdin_bytes=None):
        environment = dict(os.environ)
        environment['DSH_HOME'] = str(self.home)
        environment['DSH_CLI'] = self.dsh
        environment.pop('RUN_WORKER_EVENTS', None)
        try:
            proc = subprocess.Popen(
                argv, cwd=cwd, env=environment,
                stdin=subprocess.DEVNULL if stdin_bytes is None else subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as error:
            return None, b'', str(error).encode('utf-8')
        try:
            try:
                if stdin_bytes is None:
                    out, err = proc.communicate(timeout=self.probe_timeout)
                else:
                    out, err = proc.communicate(input=stdin_bytes, timeout=self.probe_timeout)
            except subprocess.TimeoutExpired:
                self.kill_group(proc)
                try:
                    out, err = proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    out, err = b'', b''
                err += f'live-apply: timed out after {self.probe_timeout} seconds'.encode('utf-8')
                return None, out, err
            return proc.returncode, out, err
        except KeyboardInterrupt:
            self.kill_group(proc)
            try:
                proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            raise

    @staticmethod
    def kill_group(proc):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def emit(self, status):
        record = str(self.record) if self.record_started and self.record.exists() else None
        summary = {
            'status': status,
            'route': self.route,
            'profile': self.profile,
            'target': str(self.target),
            'production': self.production,
            'ownerApproved': self.owner_approved,
            'record': record,
            'checks': self.checks,
        }
        text = json.dumps(summary, ensure_ascii=False)
        print(text)
        if record is not None:
            path = self.record / 'summary.json'
            try:
                path.write_text(text + '\n', encoding='utf-8')
                os.chmod(path, 0o600)
            except OSError as error:
                print(f'live-apply: write summary: {error}', file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='command', required=True)
    patch = subparsers.add_parser('patch', help='replace one profile or home patch')
    patch.add_argument('--source', required=True, help='the new patch file')
    patch.add_argument('--target', required=True, help='the live patch file to replace')
    patch.add_argument('--record', required=True, help="a directory for this run's record")
    patch.add_argument('--owner-approved', help="the owner's approval, naming where it was given")
    patch.add_argument('--dsh-home', help='the Harness home; defaults to $DSH_HOME or ~/.dsh')
    patch.add_argument('--run-worker', default=DEFAULT_RUN_WORKER, help='the worker launcher')
    patch.add_argument('--dsh', default='dsh', help='the DSH CLI')
    patch.add_argument('--retry-delay', type=retry_seconds, default=30,
                       help='seconds before the one retry of a failed model probe')
    patch.add_argument('--probe-timeout', type=probe_timeout_seconds, default=600.0,
                       help='seconds before a child is killed as a timeout')
    args = parser.parse_args()
    try:
        job = Apply(args)
    except UsageError as error:
        print(error, file=sys.stderr)
        return 2
    except OSError as error:
        print(f'live-apply: check usage: {error}', file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print('LIVE_APPLY_INTERRUPTED: the target was not changed', file=sys.stderr)
        return 130
    status, code = job.run()
    job.emit(status)
    return code


if __name__ == '__main__':
    sys.exit(main())
