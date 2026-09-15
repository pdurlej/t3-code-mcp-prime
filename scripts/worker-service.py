#!/usr/bin/env python3
"""Manage the opt-in per-user macOS delivery worker. No listener or credentials added."""
import argparse, os, pathlib, plistlib, shutil, subprocess, sys, time
p = argparse.ArgumentParser()
p.add_argument('action', choices=['start', 'stop', 'status'])
a = p.parse_args()
label = 'com.t3-code-mcp-prime.delivery'
root = pathlib.Path(__file__).resolve().parent.parent
plist = pathlib.Path.home() / 'Library/LaunchAgents' / (label + '.plist')
target = f'gui/{os.getuid()}/{label}'
if sys.platform != 'darwin':
    sys.exit('Use node dist/worker.js with your process manager on this platform.')
def run(*args):
    return subprocess.run(['launchctl', *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
if a.action == 'status':
    print('running' if run('print', target) == 0 else 'stopped')
elif a.action == 'stop':
    result = run('bootout', target)
    for _ in range(100):
        if run('print', target) != 0: break
        time.sleep(0.1)
    else: sys.exit('Worker is still stopping; registration retained. Retry status before starting again.')
    if plist.exists(): plist.unlink()
    print('stopped; queued messages retained')
else:
    node = shutil.which('node')
    if not node or not (root / 'dist/worker.js').exists(): sys.exit('Build first with pnpm build; node must be on PATH.')
    if run('print', target) == 0:
        print('already running'); sys.exit(0)
    state = pathlib.Path.home() / '.local/state/t3-code-mcp-prime'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    logs = state / 'worker.log'
    if logs.is_symlink() or (logs.exists() and (not logs.is_file() or logs.stat().st_uid != os.getuid())): sys.exit('Unsafe worker log file.')
    logs.touch(mode=0o600, exist_ok=True)
    logs.chmod(0o600)
    plist.parent.mkdir(parents=True, exist_ok=True)
    config = dict(Label=label, ProgramArguments=[node, str(root / 'dist/worker.js')], WorkingDirectory=str(root), RunAtLoad=True, KeepAlive=True, ThrottleInterval=15, StandardOutPath=str(logs), StandardErrorPath=str(logs))
    # Pin explicit instance overrides; never copy tokens or the whole environment.
    config['EnvironmentVariables'] = {k:os.environ[k] for k in ['T3_TOKEN_FILE','T3_DATABASE','T3_ORIGIN','T3_PRIME_STATE_DIR','T3_PRIME_ROUTES_FILE'] if k in os.environ}
    with plist.open('wb') as f: plistlib.dump(config, f)
    plist.chmod(0o600)
    if run('bootstrap', f'gui/{os.getuid()}', str(plist)) != 0: sys.exit('Could not start delivery worker.')
    print('running')
