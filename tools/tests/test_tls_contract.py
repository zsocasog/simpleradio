import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tls_contract',ROOT/'tools/check_tls_contract.py')
contract=importlib.util.module_from_spec(spec);spec.loader.exec_module(contract)
SOURCE=Path.home()/'.platformio/packages/framework-arduinoespressif32/libraries/NetworkClientSecure/src/ssl_client.cpp'

@unittest.skipUnless(SOURCE.exists(),'pinned framework not installed')
class ContractTests(unittest.TestCase):
    def test_pinned_native_timeout_is_verified_without_modifying_the_framework(self):
        text=SOURCE.read_text(encoding='utf-8');contract.verify(text);contract.verify(text.replace('\n','\r\n'))
    def test_changed_timeout_contract_is_rejected(self):
        text=SOURCE.read_text(encoding='utf-8');start=text.index('int ssl_starttls_handshake(')
        changed=text[:start]+text[start:].replace('return -1;','return -2;',1)
        with self.assertRaises(RuntimeError):contract.verify(changed)

if __name__=='__main__':unittest.main()
