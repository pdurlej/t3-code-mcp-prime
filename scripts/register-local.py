#!/usr/bin/env python3
"""Register/remove only this stdio MCP in installed Codex, Claude and Cursor clients."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib

NAME = 't3-code-mcp-prime'
ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
COMMAND = {'command':NODE,'args':[str(ROOT/'dist/server.js')]}

def run(args):
    r = subprocess.run(args,capture_output=True,text=True,timeout=30)
    if r.returncode:
        raise RuntimeError('Client registration command failed; raw output withheld')

def edit_codex(text, uninstall=False):
    section = 'mcp_servers.' + NAME
    if not uninstall:
        return text.rstrip() + '\n\n[' + section + ']\ncommand = ' + json.dumps(NODE) + '\nargs = ' + json.dumps(COMMAND['args']) + '\n'
    result = []
    removing = False
    for line in text.splitlines(keepends=True):
        header = re.match(r'^\s*\[{1,2}([^\[\]]+)\]{1,2}\s*(?:#.*)?$',line.rstrip('\n'))
        if header:
            name = header.group(1).strip()
            removing = name == section or name.startswith(section+'.')
        if not removing or line.lstrip().startswith("#") or not line.strip():
            result.append(line)
    edited = ''.join(result)
    expected = tomllib.loads(text)
    expected.get('mcp_servers', {}).pop(NAME, None)
    actual = tomllib.loads(edited)
    # An empty implicit parent table may disappear with its only child.
    if expected.get('mcp_servers') == {}: expected.pop('mcp_servers')
    if actual.get('mcp_servers') == {}: actual.pop('mcp_servers')
    if actual != expected:
        raise RuntimeError('Cannot safely remove registration without changing other TOML values')
    return edited

def atomic_write(path, text):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.prime-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:
            f.write(text);f.flush();os.fsync(f.fileno())
        os.chmod(tmp,(path.stat().st_mode & 0o777) if path.exists() else 0o600)
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def main():
    uninstall = '--uninstall' in sys.argv
    if not NODE or not (ROOT/'dist/server.js').exists():
        raise RuntimeError('Build and Node are required')
    codex = Path.home()/'.codex/config.toml'
    claude = Path.home()/'.claude.json'
    cursor = Path.home()/'.cursor/mcp.json'
    # Preflight all targets before changing any of them.
    for path in (codex,claude,cursor):
        if path.exists():
            data = tomllib.loads(path.read_text()) if path == codex else json.loads(path.read_text())
            current = data.get('mcp_servers' if path == codex else 'mcpServers',{}).get(NAME)
            if current and (current.get('command') != NODE or current.get('args') != COMMAND['args']):
                raise RuntimeError('A different registration already owns this name')
    if shutil.which('codex'):
        current = tomllib.loads(codex.read_text()).get('mcp_servers',{}).get(NAME) if codex.exists() else None
        if (uninstall and current) or (not uninstall and not current):
            atomic_write(codex,edit_codex(codex.read_text() if codex.exists() else '',uninstall))
        print('Codex: '+('removed' if uninstall else 'registered'))
    if shutil.which('claude'):
        current = json.loads(claude.read_text()).get('mcpServers',{}).get(NAME) if claude.exists() else None
        if uninstall and current: run(['claude','mcp','remove','--scope','user',NAME])
        elif not uninstall and not current: run(['claude','mcp','add','--scope','user',NAME,'--',NODE,str(ROOT/'dist/server.js')])
        print('Claude Code: '+('removed' if uninstall else 'registered'))
    if cursor.exists():
        data=json.loads(cursor.read_text())
        servers=data.setdefault('mcpServers',{})
        if uninstall: servers.pop(NAME,None)
        else: servers[NAME]=COMMAND
        fd,tmp=tempfile.mkstemp(prefix='.prime-',dir=cursor.parent)
        try:
            with os.fdopen(fd,'w') as f: json.dump(data,f,indent=2);f.write('\n')
            os.chmod(tmp,cursor.stat().st_mode & 0o777)
            os.replace(tmp,cursor)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
        print('Cursor: '+('removed' if uninstall else 'registered'))
    bindir=Path.home()/'.local/bin'
    bindir.mkdir(parents=True,exist_ok=True)
    link=bindir/'t3-mcp-prime'
    expected=str(ROOT/'scripts/t3-mcp-prime')
    if link.is_symlink() and os.readlink(link)==expected:
        if uninstall: link.unlink()
    elif link.exists() or link.is_symlink():
        raise RuntimeError('CLI path belongs to another installation')
    elif not uninstall: link.symlink_to(expected)

if __name__=='__main__':
    try: main()
    except Exception as e:
        print('Registration failed: '+str(e),file=sys.stderr);sys.exit(1)
