"""Offline contract tests: no Slack requests or real credential reads."""

import contextlib
import getpass
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request
import warnings


import unittest

# The Slack App manifests are owned by the skill, not by the store, so their
# declared read scopes are verified here rather than beside the store programs.

class ManifestScopeTests(unittest.TestCase):

    def test_manifests_have_only_declared_read_scopes(self):
        root = Path(__file__).resolve().parents[1] / "assets"
        for name, scopes in (("manifest.json", ["channels:history", "groups:history"]),
                             ("manifest-public.json", ["channels:history"]),
                             ("manifest-private.json", ["groups:history"])):
            data = json.loads((root / name).read_text())
            self.assertEqual(data["oauth_config"], {"scopes": {"bot": scopes}})
            self.assertEqual(set(data), {"display_information", "features", "oauth_config"})
            self.assertRegex(data["features"]["bot_user"]["display_name"], r"^[a-z0-9_.-]+$")


if __name__ == "__main__":
    unittest.main()
