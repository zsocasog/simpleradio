"""Check the pinned native helper's resumable WANT_READ/WRITE timeout contract.

No framework file is modified. A different native helper needs review before
short timeout slices may be used as cooperative cancellation boundaries.
"""
import hashlib
from pathlib import Path

HANDSHAKE_SHA256 = '7a623e860bf04d32c67334f771857eced86ba0396e603401b37873afced40535'

def verify(source):
    source = source.replace('\r\n', '\n')
    start = source.index('int ssl_starttls_handshake(')
    brace = source.index('{', start)
    depth = 0
    for end in range(brace, len(source)):
        depth += (source[end] == '{') - (source[end] == '}')
        if not depth: break
    if hashlib.sha256(source[start:end+1].encode()).hexdigest() != HANDSHAKE_SHA256:
        raise RuntimeError('Native TLS helper changed: review resumable timeout slices before building')

if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        framework = Path(env.PioPlatform().get_package_dir('framework-arduinoespressif32'))
        verify((framework/'libraries/NetworkClientSecure/src/ssl_client.cpp').read_text(encoding='utf-8'))
        print('SimpleRadio TLS: native resumable handshake contract verified; framework unchanged')
