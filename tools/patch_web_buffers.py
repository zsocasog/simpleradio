"""Keep pinned ESPAsyncWebServer 3.12.1 payload buffers out of internal RAM.

Only buffer allocation/ownership changes. Web file streams use a 512-byte
stdio buffer instead of the core's 4096-byte default, before any file reads.
The pinned response writer also retains EOF until buffered bytes are queued,
counts partial writes, and spends retry credit only on bytes actually queued.
This prevents truncation/deadlock on temporary TCP allocation pressure.
"""
import hashlib
from pathlib import Path

HEADER_HASH = 'b90de8322a97af18e8cd6817b7a5c27999c6a5e0097f23ecd77a4e167d9ced75'
SOURCE_HASH = '12055aa687cd0f6f719b65057c7a1d203baf6f0ef88e96b3fb4909ac68d0e6f8'
HANDLER_HASH = '43c01d2fb1208552bc940b44678086d0fae62a8756fa2db6ff68df0506ef9755'
HEADER_EDITS = [
    ('#include <memory>', '#include <memory>\n#if defined(ESP32)\n#include <esp_heap_caps.h> // SimpleRadio HTTP payload buffers\n#endif'),
    ('  std::unique_ptr<std::array<uint8_t, ASYNC_RESPONCE_BUFF_SIZE> > _send_buffer;',
     '''#if defined(ESP32)
  using SendBuffer = std::array<uint8_t, ASYNC_RESPONCE_BUFF_SIZE>;
  struct SendBufferDeleter {
    void operator()(SendBuffer* buffer) const {
      if (buffer) { buffer->~SendBuffer(); heap_caps_free(buffer); }
    }
  };
  std::unique_ptr<SendBuffer, SendBufferDeleter> _send_buffer;
#else
  std::unique_ptr<std::array<uint8_t, ASYNC_RESPONCE_BUFF_SIZE> > _send_buffer;
#endif'''),
    ('  // Data is inserted into cache at begin().',
     '''  bool _source_eof{false}; // SimpleRadio: source EOF is not TCP completion
  // Data is inserted into cache at begin().'''),
]
SOURCE_EDITS = [
    ('        auto p = new (std::nothrow) std::array<uint8_t, ASYNC_RESPONCE_BUFF_SIZE>;',
     '''#if defined(ESP32)
        void* memory = heap_caps_malloc(sizeof(SendBuffer), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        auto* p = memory ? new (memory) SendBuffer : nullptr;
#else
        auto p = new (std::nothrow) std::array<uint8_t, ASYNC_RESPONCE_BUFF_SIZE>;
#endif'''),
    ('        if (added_len != _send_buffer_len - _send_buffer_offset) {',
     '''        payloadlen += added_len; // Count partial writes too.
        if (added_len != _send_buffer_len - _send_buffer_offset) {'''),
    ('''        } else {
          _send_buffer_len = _send_buffer_offset = 0;  // consider buffer empty
        }
        payloadlen += added_len;
      }''',
     '''        } else {
          _send_buffer_len = _send_buffer_offset = 0;  // consider buffer empty
        }
      }'''),
    ('      if (tcp_win == 0 || _state == RESPONSE_END) {',
     '      if (tcp_win == 0 || _source_eof) {'),
    ('            // last chunk?\n            _state = RESPONSE_END;',
     '            // Last chunk still has framing bytes waiting for TCP.\n            _source_eof = true;'),
    ('          // no more data to send\n          _state = RESPONSE_END;',
     '          // EOF is complete only after any pending buffer drains.\n          _source_eof = true;'),
    ('            // it was last piece of content\n            _state = RESPONSE_END;',
     '            // The last source bytes may still await a partial TCP write.\n            _source_eof = true;'),
    ('\n    --_in_flight_credit;  // take a credit',
     '\n    if (payloadlen) --_in_flight_credit; // No queued bytes means no future ACK.'),
    ('\n      --_in_flight_credit;  // take a credit',
     '\n      if (pcb_written) --_in_flight_credit; // Header retries also need a future ACK.'),
    ('      _send_buffer.reset();\n    }\n    return payloadlen;',
     '''      _send_buffer.reset();
      if (_source_eof) _state = RESPONSE_END;
    }
    return payloadlen;'''),
    ('  _content = fs.open(path, fs::FileOpenMode::read);',
     '''  _content = fs.open(path, fs::FileOpenMode::read);
#if defined(ESP32)
  if (_content) _content.setBufferSize(512); // SimpleRadio web file RAM budget
#endif'''),
    ('    _content = fs.open(gzPath, fs::FileOpenMode::read);',
     '''    _content = fs.open(gzPath, fs::FileOpenMode::read);
#if defined(ESP32)
    if (_content) _content.setBufferSize(512);
#endif'''),
]
HANDLER_EDITS = [
    ('  // Get server ETag. If file is not GZ and we have a Template Processor, ETag is set to an empty string',
     '''#if defined(ESP32)
  // Set before gzip ETag reads; resizing in the File-taking response ctor
  // would be too late for streams which the caller has already read.
  request->_tempFile.setBufferSize(512); // SimpleRadio web file RAM budget
#endif
  // Get server ETag. If file is not GZ and we have a Template Processor, ETag is set to an empty string'''),
]


def patch(source, expected_hash, edits):
    original = source.replace('\r\n', '\n')
    if edits[0][1] in original:
        for old, new in edits:
            if original.count(new) != 1:
                raise RuntimeError('HTTP buffers: incomplete existing patch')
            original = original.replace(new, old)
    if hashlib.sha256(original.encode()).hexdigest() != expected_hash:
        raise RuntimeError('HTTP buffers: unfamiliar dependency source; refusing unchecked patch')
    for old, new in edits:
        if original.count(old) != 1:
            raise RuntimeError('HTTP buffers: ambiguous patch anchor')
        original = original.replace(old, new)
    return original


def patch_header(source):
    return patch(source, HEADER_HASH, HEADER_EDITS)


def patch_source(source):
    return patch(source, SOURCE_HASH, SOURCE_EDITS)


def patch_handler(source):
    return patch(source, HANDLER_HASH, HANDLER_EDITS)


def apply_to_dependency(env):
    folder = Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') / 'ESPAsyncWebServer/src'
    for name, transform in [('WebResponseImpl.h', patch_header), ('WebResponses.cpp', patch_source),
                            ('WebHandlers.cpp', patch_handler)]:
        file = folder / name
        source = file.read_text(encoding='utf-8')
        result = transform(source)
        if source != result:
            file.write_text(result, encoding='utf-8', newline='\n')
    print('SimpleRadio web: PSRAM payloads, bounded file buffers, partial-write/EOF retry verified')


if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        apply_to_dependency(env)
