import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('setup_token',Path(__file__).resolve().parents[1]/'scripts/setup-token.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class TokenSetupTest(unittest.TestCase):
    def exercise(self,bad_scope=False,bad_json=False):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            dbpath=home/'state.sqlite'
            root=home/'token-dir'
            runtime=home/'.t3/userdata';runtime.mkdir(parents=True)
            (runtime/'server-runtime.json').write_text('{"origin":"http://127.0.0.1:3773"}')
            db=sqlite3.connect(dbpath)
            db.execute('create table auth_sessions(session_id text,client_label text,scopes text,expires_at text,revoked_at text)')
            db.execute('create table auth_pairing_links(id text,revoked_at text,consumed_at text)')
            labels={}
            def cli(*args):
                if args[:3]==('auth','session','issue'):
                    label=args[args.index('--label')+1];labels['base']=label.removesuffix('-bootstrap')
                    db.execute('insert into auth_sessions values(?,?,?,?,NULL)',('boot',label,'[]','future'));db.commit()
                    return '{' if bad_json else json.dumps({'sessionId':'boot','token':'NEVER-PRINT-BOOT'})
                if args[:3]==('auth','session','revoke'):
                    self.assertEqual(len(args),4) # actual bundled CLI uses positional ID
                    db.execute("update auth_sessions set revoked_at='now' where session_id=?",(args[3],));db.commit();return ''
                if args[:3]==('auth','pairing','revoke'):
                    db.execute("update auth_pairing_links set revoked_at='now' where id=?",(args[3],));db.commit();return ''
                raise AssertionError('unexpected CLI operation')
            def request(origin,path,body=None,token=None,form=False):
                if path=='/api/auth/pairing-token':
                    self.assertEqual(body['scopes'],module.SCOPES)
                    db.execute("insert into auth_pairing_links values('pair',NULL,NULL)");db.commit()
                    return {'id':'pair','credential':'NEVER-PRINT-PAIR'}
                if path=='/oauth/token':
                    scopes=module.SCOPES+(['access:write'] if bad_scope else [])
                    db.execute('insert into auth_sessions values(?,?,?,?,NULL)',('child',labels['base'],json.dumps(scopes),'future'));db.commit()
                    return {'access_token':'NEVER-PRINT-CHILD','scope':' '.join(scopes)}
                if path=='/api/orchestration/shell':return {}
                raise AssertionError('unexpected HTTP operation')
            out=io.StringIO()
            with patch.object(module,'ROOT',root),patch.object(module,'DB',dbpath),patch.object(Path,'home',return_value=home),patch.object(module,'cli',side_effect=cli),patch.object(module,'request',side_effect=request),patch.object(module.sys,'argv',['setup-token.py']),contextlib.redirect_stdout(out):
                if bad_scope or bad_json:
                    with self.assertRaises(Exception):module.main()
                else:module.main()
            self.assertNotIn('NEVER-PRINT',out.getvalue())
            active=[r[0] for r in db.execute('select session_id from auth_sessions where revoked_at is null')]
            self.assertEqual(active,[] if bad_scope or bad_json else ['child'])
            self.assertEqual((root/'token').exists(),not (bad_scope or bad_json))
            if not bad_scope and not bad_json:
                self.assertEqual((root/'token').stat().st_mode & 0o777,0o600)
                self.assertEqual(json.loads((root/'credential.json').read_text())['scopes'],module.SCOPES)
            db.close()
    def test_success_saves_only_scoped_child(self):self.exercise()
    def test_scope_validation_failure_revokes_unrecorded_child(self):self.exercise(bad_scope=True)
    def test_bootstrap_parse_failure_still_revokes_by_unique_label(self):self.exercise(bad_json=True)

    def test_recorded_cleanup_blocks_new_token_then_revoke_resolves_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);recovery=root/'cleanup-session-ids.json';recovery.write_text('["orphan"]')
            with patch.object(module,'ROOT',root),patch.object(module.sys,'argv',['setup-token.py']),patch.object(module,'cli') as cli:
                with self.assertRaisesRegex(RuntimeError,'cleanup'):module.main()
                cli.assert_not_called()
            with patch.object(module,'ROOT',root),patch.object(module.sys,'argv',['setup-token.py','--revoke']),patch.object(module,'revoke_id') as revoke,contextlib.redirect_stdout(io.StringIO()):
                module.main();revoke.assert_called_once_with('orphan')
            self.assertFalse(recovery.exists())
    def test_missing_session_row_does_not_erase_token_or_claim_revocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);dbpath=root/'db.sqlite';db=sqlite3.connect(dbpath)
            db.execute('create table auth_sessions(session_id text,revoked_at text)');db.commit();db.close()
            receipt={'sessionId':'missing'};(root/'credential.json').write_text(json.dumps(receipt));(root/'token').write_text('PRESERVE')
            with patch.object(module,'ROOT',root),patch.object(module,'DB',dbpath),patch.object(module.sys,'argv',['setup-token.py','--revoke']),patch.object(module,'cli',return_value=''):
                with self.assertRaisesRegex(RuntimeError,'not confirmed'):module.main()
            self.assertEqual((root/'token').read_text(),'PRESERVE')
            self.assertEqual(json.loads((root/'credential.json').read_text()),receipt)
