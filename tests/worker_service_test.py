import contextlib
import io
import os
from pathlib import Path
import plistlib
import runpy
import tempfile
import unittest
from unittest.mock import patch
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/worker-service.py'
class WorkerServiceTest(unittest.TestCase):
    def test_start_pins_token_path_and_hardens_existing_log(self):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d)
            log=home/'.local/state/t3-code-mcp-prime/worker.log'
            log.parent.mkdir(parents=True)
            log.touch(mode=0o644)
            def command(args,**kwargs):
                class Result: returncode=1 if args[1]=='print' else 0
                return Result()
            with patch('pathlib.Path.home',return_value=home), patch('sys.platform','darwin'), patch('sys.argv',[str(SCRIPT),'start']), patch('shutil.which',return_value='/usr/local/bin/node'), patch('subprocess.run',side_effect=command), patch.dict(os.environ,{'T3_TOKEN_FILE':'/private/config/token'},clear=True), contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(SCRIPT),run_name='__main__')
            conf=plistlib.loads((home/'Library/LaunchAgents/com.t3-code-mcp-prime.delivery.plist').read_bytes())
            self.assertEqual(conf['EnvironmentVariables'],{'T3_TOKEN_FILE':'/private/config/token'})
            self.assertEqual(log.stat().st_mode & 0o777,0o600)
