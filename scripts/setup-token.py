#!/usr/bin/env python3
"""Provision one orchestration-only T3 credential. Secret values never leave memory/file."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import urllib.request
import urllib.parse
import uuid

ROOT = Path.home() / '.config/t3-code-mcp-prime'
APP = Path('/Applications/T3 Code (Alpha).app/Contents')
CLI = [str(APP / 'MacOS/T3 Code (Alpha)'), str(APP / 'Resources/app.asar/apps/server/dist/bin.mjs')]
DB = Path.home() / '.t3/userdata/state.sqlite'
SCOPES = ['orchestration:read', 'orchestration:operate']

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Redirect refused')

def cli(*args):
    r = subprocess.run(CLI + list(args), env={**os.environ, 'ELECTRON_RUN_AS_NODE':'1'}, capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise RuntimeError('T3 credential CLI failed; raw output withheld')
    return r.stdout

def request(origin, path, body=None, token=None, form=False):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        body = (urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
    r = urllib.request.Request(origin + path, data=body, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(r, timeout=10) as response:
        return json.load(response)

def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(value)

def revoke_id(identifier):
    pairing = identifier.startswith('pairing:')
    value = identifier.removeprefix('pairing:') if pairing else identifier
    cli('auth','pairing' if pairing else 'session','revoke',value)
    with sqlite3.connect(f'file:{DB}?mode=ro',uri=True) as c:
        row = c.execute(
            'select coalesce(revoked_at,consumed_at) from auth_pairing_links where id=?' if pairing
            else 'select revoked_at from auth_sessions where session_id=?', (value,)).fetchone()
    if not row or row[0] is None:
        raise RuntimeError('Revocation not confirmed')

def main():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_path = ROOT / 'token'
    receipt_path = ROOT / 'credential.json'
    recovery_path = ROOT / 'cleanup-session-ids.json'
    if recovery_path.exists():
        if '--revoke' not in sys.argv:
            raise RuntimeError('Finish recorded credential cleanup with --revoke before provisioning')
        for identifier in json.loads(recovery_path.read_text()):
            revoke_id(identifier)
        recovery_path.unlink()
        if not receipt_path.exists():
            print('Recorded credential cleanup confirmed.')
            return
    if '--revoke' in sys.argv:
        receipt = json.loads(receipt_path.read_text())
        revoke_id(receipt['sessionId'])
        token_path.unlink(missing_ok=True)
        receipt['revoked'] = True
        receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
        print('Dedicated T3 MCP Prime credential revoked; unrelated sessions unchanged.')
        return
    if token_path.exists() or receipt_path.exists():
        raise RuntimeError('Token already exists; refusing to replace it')
    runtime = json.loads((Path.home()/'.t3/userdata/server-runtime.json').read_text())
    origin = runtime['origin']
    url = urllib.parse.urlsplit(origin)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1','localhost','::1') or url.username or url.password or url.path not in ('','/') or url.query or url.fragment:
        raise RuntimeError('Non-loopback origin refused')
    bootstrap = None
    child_id = None
    pairing_id = None
    saved = False
    token_written = False
    label = 't3-code-mcp-prime-' + uuid.uuid4().hex[:12]
    try:
        bootstrap = json.loads(cli('auth','session','issue','--ttl','5m','--label',label+'-bootstrap','--json'))
        pair = request(origin,'/api/auth/pairing-token',{'label':label,'scopes':SCOPES},bootstrap['token'])
        pairing_id = pair['id']
        child = request(origin,'/oauth/token',{
            'grant_type':'urn:ietf:params:oauth:grant-type:token-exchange',
            'subject_token':pair['credential'],
            'subject_token_type':'urn:t3:params:oauth:token-type:environment-bootstrap',
            'requested_token_type':'urn:ietf:params:oauth:token-type:access_token',
            'scope':' '.join(SCOPES),'client_label':label,'client_device_type':'desktop','client_os':'macOS',
        },form=True)
        if sorted(child['scope'].split()) != sorted(SCOPES):
            raise RuntimeError('Unexpected credential scopes')
        with sqlite3.connect(f'file:{DB}?mode=ro',uri=True) as c:
            rows = c.execute('select session_id,scopes,expires_at from auth_sessions where client_label=? and revoked_at is null',(label,)).fetchall()
        if len(rows) != 1:
            raise RuntimeError('Dedicated session could not be identified')
        child_id, scopes, expiry = rows[0]
        if sorted(json.loads(scopes)) != sorted(SCOPES):
            raise RuntimeError('Stored scopes differ')
        request(origin,'/api/orchestration/shell',token=child['access_token'])
        private_write(token_path,child['access_token']+'\n')
        token_written = True
        private_write(receipt_path,json.dumps({'sessionId':child_id,'label':label,'scopes':SCOPES,'expiresAt':expiry},indent=2)+'\n')
        saved = True
    finally:
        cleanup_errors = []
        # Locate by our unique per-run label even if parsing or scope validation
        # failed after issuance. Never touch unrelated client sessions.
        with sqlite3.connect(f'file:{DB}?mode=ro',uri=True) as c:
            boot_ids = [r[0] for r in c.execute(
                'select session_id from auth_sessions where client_label=? and revoked_at is null',
                (label+'-bootstrap',))]
            child_ids = [r[0] for r in c.execute(
                'select session_id from auth_sessions where client_label=? and revoked_at is null',
                (label,))] if not saved else []
        if bootstrap and bootstrap['sessionId'] not in boot_ids:
            boot_ids.append(bootstrap['sessionId'])
        for session_id in child_ids + boot_ids:
            try:
                revoke_id(session_id)
            except Exception:
                cleanup_errors.append(session_id)
        if not saved:
            if token_written:
                token_path.unlink(missing_ok=True)
            if pairing_id:
                try:
                    revoke_id('pairing:'+pairing_id)
                except Exception:
                    cleanup_errors.append('pairing:'+pairing_id)
        if cleanup_errors:
            recovery = ROOT/'cleanup-session-ids.json'
            recovery.write_text(json.dumps(cleanup_errors)+'\n')
            os.chmod(recovery,0o600)
            raise RuntimeError('Credential cleanup requires retry; session IDs saved locally')
    print('Dedicated token ready: orchestration:read + orchestration:operate. Temporary admin revoked. Token not printed.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Credential setup failed ('+type(error).__name__+'); no secret values or raw responses printed.',file=sys.stderr)
        sys.exit(1)
