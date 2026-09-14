import importlib.util
from pathlib import Path
import unittest
import tomllib

spec=importlib.util.spec_from_file_location('register_local',Path(__file__).resolve().parents[1]/'scripts/register-local.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class RegisterTest(unittest.TestCase):
    def test_codex_add_remove_preserves_other_entries_and_tables(self):
        original='[mcp_servers.other]\ncommand="keep"\nstartup_timeout_sec=30\n\n[other_settings]\nx=true\n'
        added=module.edit_codex(original)
        self.assertTrue(added.startswith(original.rstrip()))
        d=tomllib.loads(added)
        self.assertEqual(d['mcp_servers']['other'],tomllib.loads(original)['mcp_servers']['other'])
        # Also preserve sections after our own entry, not only before it.
        removed=module.edit_codex(added+'\n[another_table]\ny=12\n',True)
        parsed=tomllib.loads(removed)
        self.assertNotIn(module.NAME,parsed['mcp_servers'])
        self.assertEqual(parsed['another_table'],{'y':12})
        self.assertEqual(parsed['mcp_servers']['other'],d['mcp_servers']['other'])

    def test_remove_preserves_following_array_tables(self):
        text='[mcp_servers.t3-code-mcp-prime]\ncommand="node"\n\n[[agents]]\nname="keep"\n'
        removed=module.edit_codex(text,True)
        self.assertEqual(tomllib.loads(removed)['agents'],[{'name':'keep'}])

    def test_remove_preserves_comments_and_spacing(self):
        text='[mcp_servers.t3-code-mcp-prime]\ncommand="node"\n\n# user explanation\n[[agents]]\nname="keep"\n'
        removed=module.edit_codex(text,True)
        self.assertIn('\n# user explanation\n[[agents]]',removed)
        self.assertEqual(tomllib.loads(removed)['agents'],[{'name':'keep'}])
