"""Reviewed overlay on the pinned, already verified HTTP response writer.

Limit unacknowledged abstract-response bytes per connection, including headers.
The parent buffer/deferred patchers still verify the complete upstream source.
"""
MARKER = 'SimpleRadio: at most two TCP segments'
EDITS = [
    ('''  // return a credit for each chunk of acked data (polls does not give any credits)
  if (len) {
    ++_in_flight_credit;
    _in_flight -= std::min(len, _in_flight);
  }

  if (_chunked || !_sendContentLength || (_sentLength > CONFIG_LWIP_TCP_WND_DEFAULT)) {
    if (!_in_flight_credit || (ASYNC_RESPONCE_BUFF_SIZE > request->client()->space())) {
      // async_ws_log_d("defer user call in_flight:%u, tcpwin:%u", _in_flight, request->client()->space());
      // take the credit back since we are ignoring this ack and rely on other inflight data acks
      if (len) {
        --_in_flight_credit;
      }
      return 0;
    }
  }''', '''  // SimpleRadio: at most two TCP segments outstanding per response.
  // Byte ACKs replenish the window; polls retry refused writes without
  // inventing credits or refilling a whole TCP window for every client.
  if (len) _in_flight -= std::min(len, _in_flight);
  if (_in_flight >= 2 * CONFIG_LWIP_TCP_MSS) return 0;'''),
    ('''    size_t const pcb_written = request->client()->add(_assembled_headers.c_str() + _writtenHeadersLength, _assembled_headers.length() - _writtenHeadersLength);
    _writtenLength += pcb_written;
    _writtenHeadersLength += pcb_written;
    if (_writtenHeadersLength < _assembled_headers.length()) {
//''', '''    size_t headerBudget = _assembled_headers.length() - _writtenHeadersLength;
#if ASYNCWEBSERVER_USE_CHUNK_INFLIGHT
    headerBudget = std::min(headerBudget, 2 * CONFIG_LWIP_TCP_MSS - _in_flight);
#endif
    size_t const pcb_written = request->client()->add(_assembled_headers.c_str() + _writtenHeadersLength, headerBudget);
    _writtenLength += pcb_written;
    _writtenHeadersLength += pcb_written;
    if (_writtenHeadersLength < _assembled_headers.length()) {
//'''),
    ('      if (pcb_written) --_in_flight_credit; // Header retries also need a future ACK.',
     '      // Header bytes occupy the same bounded outstanding window.'),
    ('''    do {
      if (_send_buffer_len && _send_buffer) {''', '''    do {
#if ASYNCWEBSERVER_USE_CHUNK_INFLIGHT
      if (payloadlen >= 2 * CONFIG_LWIP_TCP_MSS - _in_flight) break;
#endif
      if (_send_buffer_len && _send_buffer) {'''),
    ('''        size_t const added_len =
          request->client()->add(reinterpret_cast<char *>(_send_buffer->data() + _send_buffer_offset), _send_buffer_len - _send_buffer_offset);''', '''        size_t pendingBudget = _send_buffer_len - _send_buffer_offset;
#if ASYNCWEBSERVER_USE_CHUNK_INFLIGHT
        pendingBudget = std::min(pendingBudget, 2 * CONFIG_LWIP_TCP_MSS - _in_flight - payloadlen);
#endif
        size_t const added_len =
          request->client()->add(reinterpret_cast<char *>(_send_buffer->data() + _send_buffer_offset), pendingBudget);'''),
    ('''      auto tcp_win = request->client()->space();
      if (tcp_win == 0 || _source_eof)''', '''      auto tcp_win = request->client()->space();
#if ASYNCWEBSERVER_USE_CHUNK_INFLIGHT
      tcp_win = std::min(tcp_win, 2 * CONFIG_LWIP_TCP_MSS - _in_flight - payloadlen);
#endif
      if (tcp_win == 0 || _source_eof)'''),
    ('    if (payloadlen) --_in_flight_credit; // No queued bytes means no future ACK.',
     '    // Outstanding bytes, rather than callback count, control admission.'),
    ('request->client()->add(_assembled_headers.c_str() + _writtenHeadersLength, headerBudget)',
     'request->addToResponse(_assembled_headers.c_str() + _writtenHeadersLength, headerBudget)'),
    ('request->client()->add(reinterpret_cast<char *>(_send_buffer->data() + _send_buffer_offset), pendingBudget)',
     'request->addToResponse(reinterpret_cast<char *>(_send_buffer->data() + _send_buffer_offset), pendingBudget)'),
]

EDITS.append(('          _send_buffer_offset += added_len;\n          break;', '          _send_buffer_offset += added_len;\n          if (added_len) continue; // A bounded write quantum is not a TCP refusal.\n          break;'))

BUDGET_MARKER = 'SimpleRadio shared TCP byte budget'
BASIC_EDITS = [
    ('request->client()->add(_assembled_headers.c_str() + _writtenHeadersLength, _assembled_headers.length() - _writtenHeadersLength)',
     'request->addToResponse(_assembled_headers.c_str() + _writtenHeadersLength, _assembled_headers.length() - _writtenHeadersLength)'),
    ('request->client()->write(_content.c_str() + _sentLength, _content.length() - _sentLength)',
     'request->addToResponse(_content.c_str() + _sentLength, _content.length() - _sentLength)'),
    ('    _sentLength += pcb_written;     // body written data',
     '    request->client()->send(); // SimpleRadio: flush headers, including empty bodies\n    _sentLength += pcb_written;     // body written data'),
]
FLUSH_EDITS = [
    ('''      if (!request->client()->send()) {
        // something is wrong, what should we do here?
        request->client()->close();
        return 0;
      }''', '''      request->sendResponse(); // A refused tcp_output is retried by poll.'''),
    ('request->client()->send();', 'request->sendResponse();'),
]
REQUEST_HEADER_EDITS = [
    ('''    AsyncWebServerRequest *req = new (std::nothrow) AsyncWebServerRequest(server, client);
    if (req) {
      req->_this = std::shared_ptr<AsyncWebServerRequest>(req);  // store shared pointer to this request
      return req->_this;
    }''', '''#if defined(ESP32)
    // Requests are task-owned metadata, never DMA buffers or ISR state.
    // Do not consume scarce network-capable RAM for every waiting browser GET.
    void* memory = heap_caps_malloc(sizeof(AsyncWebServerRequest), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    auto* req = memory ? new (memory) AsyncWebServerRequest(server, client) : nullptr;
#else
    AsyncWebServerRequest *req = new (std::nothrow) AsyncWebServerRequest(server, client);
#endif
    if (req) {
#if defined(ESP32)
      req->_this = std::shared_ptr<AsyncWebServerRequest>(req, [](AsyncWebServerRequest* request) {
        request->~AsyncWebServerRequest();
        heap_caps_free(request);
      });
#else
      req->_this = std::shared_ptr<AsyncWebServerRequest>(req);
#endif
      return req->_this;
    }'''),
    ('class AsyncWebServerResponse {\nprotected:', 'class AsyncWebServerResponse {\n#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS\n  friend class AsyncWebServerRequest;\n#endif\nprotected:'),
    ('#include <atomic> // SimpleRadio deferred response ownership',
     '#include <atomic> // SimpleRadio deferred response ownership\n#include "SimpleRadioTxBudget.h" // SimpleRadio shared TCP byte budget'),
    ('  std::atomic<AsyncWebServerResponse *> _deferredResponse{nullptr};',
     '  std::atomic<AsyncWebServerResponse *> _deferredResponse{nullptr};\n  SharedTxBudget _responseTxBytes;\n  ResponseTxTurn _responseTxTurn;\n  size_t _responseTurnBytes = 0;\n  bool _responseNeedsFlush = false;'),
    ('  bool sendDeferred(AsyncWebServerResponse *response);', '''  bool sendDeferred(AsyncWebServerResponse *response);
  size_t addToResponse(const char *data, size_t length);
  bool sendResponse();
  void releaseResponseBytes(size_t length);
  void releaseResponseTurn();
  static void pumpResponseTx();
  static size_t responseTxOutstanding();
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  static String responseTxDebug();
#endif
  static size_t responseTxActive();
  static void holdResponseTx();
  static void releaseResponseTx();
  static bool responseTxQuiescent();
  static size_t responseTxLimit();'''),
]
REQUEST_SOURCE_EDITS = [
    ('using namespace asyncsrv;', r'''using namespace asyncsrv;

namespace { // SimpleRadio shared TCP byte budget
SharedTxBudget& sharedResponseTx = responseSharedBytes();
SharedTxBudget sharedResponseSlots;
ResponseTxGate& sharedResponseGate = responseSharedGate();
ResponseTxQueue sharedResponseQueue;
portMUX_TYPE responseTurnMux = portMUX_INITIALIZER_UNLOCKED;
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
AsyncWebServerRequest* debugResponseOwners[2] = {};
#endif
constexpr size_t SHARED_RESPONSE_TX_LIMIT = 4U * CONFIG_LWIP_TCP_MSS;
}
size_t AsyncWebServerRequest::responseTxOutstanding() { return sharedResponseTx.used(); }
size_t AsyncWebServerRequest::responseTxActive() { return sharedResponseSlots.used(); }
void AsyncWebServerRequest::holdResponseTx() { sharedResponseGate.hold(); }
void AsyncWebServerRequest::releaseResponseTx() { sharedResponseGate.release(); }
bool AsyncWebServerRequest::responseTxQuiescent() { return sharedResponseGate.quiet(); }
size_t AsyncWebServerRequest::responseTxLimit() { return SHARED_RESPONSE_TX_LIMIT; }
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
String AsyncWebServerRequest::responseTxDebug() {
  String out; out.reserve(640);
  out = "{\"networkProbe\":true,\"bytes\":"; out += sharedResponseTx.used();
  out += ",\"owners\":"; out += sharedResponseSlots.used();
  out += ",\"holds\":"; out += sharedResponseGate.holds();
  out += ",\"dma\":"; out += heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT | MALLOC_CAP_DMA);
  out += ",\"largest\":"; out += heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT | MALLOC_CAP_DMA);
  out += ",\"objectBytes\":"; out += sizeof(AsyncWebServerRequest);
  out += ",\"responses\":[";
  bool comma = false;
  for (auto* request : debugResponseOwners) {
    if (!request) continue;
    if (comma) out += ',';
    comma = true;
    char item[200];
    auto* response = request->_response;
    snprintf(item, sizeof(item), "{\"bytes\":%u,\"space\":%u,\"flush\":%u,\"state\":%d,\"written\":%u,\"source\":%u,\"total\":%u}",
      unsigned(request->_responseTxBytes.used()), unsigned(request->_client ? request->_client->space() : 0), unsigned(request->_responseNeedsFlush),
      response ? int(response->_state) : -1, response ? unsigned(response->_writtenLength) : 0,
      response ? unsigned(response->_sentLength) : 0, response ? unsigned(response->_contentLength) : 0);
    out += item;
  }
  out += "]}";
  return out;
}
#endif
bool AsyncWebServerRequest::sendResponse() {
  if (!_responseNeedsFlush) return true; // Empty polls must not restart the TCP ACK timer.
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  const uint32_t started = millis();
#endif
  const bool sent = _client && _client->send();
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  ResponseTxTimings::record(responseTxTimings().sendMaxMs, millis() - started);
#endif
  _responseNeedsFlush = !sent;
  return sent;
}
void AsyncWebServerRequest::releaseResponseTurn() {
  portENTER_CRITICAL(&responseTurnMux);
  sharedResponseQueue.remove(&_responseTxTurn);
  portEXIT_CRITICAL(&responseTurnMux);
}
void AsyncWebServerRequest::pumpResponseTx() {
  // Network callback only. An ACK hands its freed slot directly to a waiting
  // response, rather than leaving it idle until that client's 500ms poll.
  // The shared owner survives disconnect; no recursive ACK dispatch or task.
  for (unsigned attempt = 0; attempt < 2; ++attempt) {
    std::shared_ptr<AsyncWebServerRequest> next;
    portENTER_CRITICAL(&responseTurnMux);
    if (auto* turn = sharedResponseQueue.front())
      next = static_cast<AsyncWebServerRequest*>(turn->owner)->_this;
    portEXIT_CRITICAL(&responseTurnMux);
    if (!next) break;
    if (!next->_response || !next->_client || !next->_client->canSend() || next->_response->_finished()) {
      next->releaseResponseTurn(); // Rejoin on its own poll when ready; never block other clients.
      continue;
    }
    next->_response->_ack(next.get(), 0, 0);
    if (next->_responseTxTurn.waiting) break;
  }
}
void AsyncWebServerRequest::releaseResponseBytes(size_t length) {
  const size_t before = _responseTxBytes.used();
  sharedResponseTx.release(_responseTxBytes.release(length));
  if (before && !_responseTxBytes.used()) {
    sharedResponseSlots.release(1);
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
    for (auto& owner : debugResponseOwners) if (owner == this) owner = nullptr;
#endif
  }
}
size_t AsyncWebServerRequest::addToResponse(const char *data, size_t length) {
  if (responseAudioWindow().blocked(millis())) return 0;
  if (!_client || !_client->canSend()) return 0;
  ResponseTxPermit permit(sharedResponseGate);
  if (!permit.acquired()) return 0;
  const size_t mss = _client->getMss();
  length = responseTxMemoryAllowance(length,
      heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT | MALLOC_CAP_DMA),
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT | MALLOC_CAP_DMA), mss, sharedResponseTx.used());
  length = std::min(length, 2U * CONFIG_LWIP_TCP_MSS - std::min(_responseTxBytes.used(), 2U * CONFIG_LWIP_TCP_MSS));
  if (!length) return 0;
  // Even a tiny header owns a whole TCP buffer. Bound owners, not just bytes.
  const bool first = !_responseTxBytes.used();
  portENTER_CRITICAL(&responseTurnMux);
  const bool waiting = sharedResponseQueue.front() != nullptr;
  portEXIT_CRITICAL(&responseTurnMux);
  const size_t burst = 2U * CONFIG_LWIP_TCP_MSS;
  if (!first && waiting) {
    if (_responseTurnBytes >= burst) return 0;
    length = std::min(length, burst - _responseTurnBytes);
  }
  if (first) {
    _responseTurnBytes = 0;
    _responseTxTurn.owner = this;
    portENTER_CRITICAL(&responseTurnMux);
    const bool turn = sharedResponseQueue.enter(&_responseTxTurn);
    portEXIT_CRITICAL(&responseTurnMux);
    if (!turn) return 0;
  }
  if (first && !sharedResponseSlots.reserve(1, 2)) return 0;
  _responseTxBytes.charge(length);
  sharedResponseTx.charge(length);
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  const uint32_t started = millis();
#endif
  const size_t queued = _client ? _client->add(data, length) : 0;
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  ResponseTxTimings::record(responseTxTimings().addMaxMs, millis() - started);
#endif
  releaseResponseBytes(length - queued);
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  if (queued && first) for (auto& owner : debugResponseOwners) if (!owner) { owner = this; break; }
#endif
  if (queued) {
    _responseNeedsFlush = true;
    _responseTurnBytes = std::min(burst, _responseTurnBytes + queued);
    releaseResponseTurn();
  }
  return queued;
}'''),
    ('void AsyncWebServerRequest::_onAck(size_t len, uint32_t time) {',
     'void AsyncWebServerRequest::_onAck(size_t len, uint32_t time) {\n  releaseResponseBytes(len);'),
    ('  // os_printf("p\\n");', '  if (_responseNeedsFlush) sendResponse(); // Retry only a refused flush, not unacknowledged data.\n  // os_printf("p\\n");'),
    ('''    _response->_ack(this, 0, 0);
  }
}

void AsyncWebServerRequest::_onAck''', '''    _response->_ack(this, 0, 0);
  }
  pumpResponseTx();
}

void AsyncWebServerRequest::_onAck'''),
    ('''}

void AsyncWebServerRequest::_onError(int8_t error) {''', '''  pumpResponseTx();
}

void AsyncWebServerRequest::_onError(int8_t error) {'''),
    ('if (_response->_finished()) {\n      _client->close();',
     'if (_response->_finished() && !_responseTxBytes.used()) {\n      _client->close();'),
    ('''  } else {
    // this will close responses that were complete via a single _send() call
    _client->close();''', '''  } else if (!_responseTxBytes.used()) {
    // SimpleRadio: keep the request and TCP budget until the final byte ACK.
    // The original first-ACK close detached still-outstanding TCP buffers.
    _client->close();'''),
    ('void AsyncWebServerRequest::_onDisconnect() {',
     'void AsyncWebServerRequest::_onDisconnect() {\n  releaseResponseBytes(static_cast<size_t>(-1));\n  releaseResponseTurn();'),
    ('''    _client = nullptr;
  }

  if (_response) {
    delete _response;''', '''    _client = nullptr;
  }

  releaseResponseBytes(static_cast<size_t>(-1));
  releaseResponseTurn();
  if (_response) {
    delete _response;'''),
    ('void AsyncWebServerRequest::_onData(void *buf, size_t len) {', '''void AsyncWebServerRequest::_onData(void *buf, size_t len) {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  ResponseCallbackTimer timer(responseTxTimings().dataMaxMs);
#endif'''),
    ('void AsyncWebServerRequest::_onAck(size_t len, uint32_t time) {', '''void AsyncWebServerRequest::_onAck(size_t len, uint32_t time) {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  ResponseCallbackTimer timer(responseTxTimings().ackMaxMs);
#endif'''),
    ('void AsyncWebServerRequest::_onPoll() {', '''void AsyncWebServerRequest::_onPoll() {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  ResponseCallbackTimer timer(responseTxTimings().pollMaxMs);
#endif'''),
    ('void AsyncWebServerRequest::_onDisconnect() {', '''void AsyncWebServerRequest::_onDisconnect() {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  ResponseCallbackTimer timer(responseTxTimings().disconnectMaxMs);
#endif'''),
]


def request_edits(source):
    return REQUEST_SOURCE_EDITS if 'using namespace asyncsrv;' in source else REQUEST_HEADER_EDITS


def strip_request(source):
    if BUDGET_MARKER not in source: return source
    for old,new in reversed(request_edits(source)):
        if source.count(new)!=1: raise RuntimeError('HTTP flow: incomplete request byte accounting')
        source=source.replace(new,old)
    return source


def apply_request(source):
    source=strip_request(source)
    for old,new in request_edits(source):
        if source.count(old)!=1: raise RuntimeError('HTTP flow: unknown request byte-accounting anchor')
        source=source.replace(old,new)
    return source


def strip(source):
    source = source.replace('\r\n', '\n')
    # Flush retry edits cover both Basic and Abstract state machines.
    if 'request->sendResponse();' in source:
        if source.count(FLUSH_EDITS[0][1])!=2 or source.count(FLUSH_EDITS[1][1])!=4:
            raise RuntimeError('HTTP flow: partial flush retry layer')
        for old,new in FLUSH_EDITS: source=source.replace(new,old)
    basic_start = source.index('size_t AsyncBasicResponse::write_send_buffs(')
    basic_end = source.index('AsyncAbstractResponse::AsyncAbstractResponse', basic_start)
    basic = source[basic_start:basic_end]
    applied_basic = [i for i,(_,new) in enumerate(BASIC_EDITS) if new in basic]
    if applied_basic:
        if applied_basic != list(range(len(BASIC_EDITS))): raise RuntimeError('HTTP flow: partial basic response budget')
        for old,new in reversed(BASIC_EDITS):
            if basic.count(new)!=1: raise RuntimeError('HTTP flow: ambiguous basic response budget')
            basic=basic.replace(new,old)
        source=source[:basic_start]+basic+source[basic_end:]
    # The budgeted-add overlay edits two of the earlier window replacements.
    # Undo those outer edits first, before verifying the complete inner layer.
    outer=[i for i in range(7,len(EDITS)) if EDITS[i][1] in source]
    if outer:
        if outer!=list(range(7,len(EDITS))): raise RuntimeError('HTTP flow: partial shared byte window')
        for i in reversed(outer):
            old,new=EDITS[i]
            if source.count(new)!=1: raise RuntimeError('HTTP flow: ambiguous shared byte window')
            source=source.replace(new,old)
    applied = [i for i, (_, new) in enumerate(EDITS[:7]) if new in source]
    if outer and not applied: raise RuntimeError('HTTP flow: shared window without complete inner layer')
    if not applied: return source
    if applied != list(range(7)):
        raise RuntimeError('HTTP flow: incomplete existing overlay')
    for i in reversed(applied):
        old,new=EDITS[i]
        if source.count(new) != 1: raise RuntimeError('HTTP flow: ambiguous overlay')
        source = source.replace(new, old)
    return source


def apply(source):
    source = strip(source)
    for old, new in EDITS:
        if source.count(old) != 1: raise RuntimeError('HTTP flow: unfamiliar response writer')
        source = source.replace(old, new)
    basic_start = source.index('size_t AsyncBasicResponse::write_send_buffs(')
    basic_end = source.index('AsyncAbstractResponse::AsyncAbstractResponse', basic_start)
    basic=source[basic_start:basic_end]
    for old,new in BASIC_EDITS:
        if basic.count(old)!=1: raise RuntimeError('HTTP flow: unfamiliar basic response writer')
        basic=basic.replace(old,new)
    source=source[:basic_start]+basic+source[basic_end:]
    # Three existing send() sites plus Basic's body flush; never close a
    # healthy client merely because tcp_output temporarily refused a send.
    for old,new in FLUSH_EDITS:
        if old not in source: raise RuntimeError('HTTP flow: unfamiliar flush site')
        source=source.replace(old,new)
    return source
