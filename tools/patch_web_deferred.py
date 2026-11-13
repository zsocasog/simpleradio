"""Start paused replies in AsyncTCP, not concurrently in main/worker tasks.

Pinned ESPAsyncWebServer 3.12.1 publishes _response before _respond assembles
its headers. A concurrent poll can interpret an empty header buffer as sent
and emit body bytes first. Publish an owned response pointer atomically, then
let the request's existing network poll start it. No task, payload copy or lock.
"""
import hashlib
from pathlib import Path

DEFERRED_HEADER_HASH = '25db7c8fb30943307b28b181722187a65576f6ee778eeb99e29b1ef8db7915ba'
DEFERRED_SOURCE_HASH = '3ca1c44ffef44e4fd7d8e900857e797469cd336bf846f2a9af61e02a0956e7ad'
DEFERRED_HEADER_EDITS = [
    ('#include <memory>', '#include <memory>\n#include <atomic> // SimpleRadio deferred response ownership'),
    ('  AsyncWebServerResponse *_response;',
     '  AsyncWebServerResponse *_response;\n  std::atomic<AsyncWebServerResponse *> _deferredResponse{nullptr};'),
    ('  void send(AsyncWebServerResponse *response);', '''  void send(AsyncWebServerResponse *response);
  // SimpleRadio: call once with a fully built response, on a paused request
  // held by a shared continuation. Ownership transfers only on success.
  bool sendDeferred(AsyncWebServerResponse *response);'''),
]
DEFERRED_SOURCE_EDITS = [
    ('AsyncWebServerRequest::~AsyncWebServerRequest() {', '''AsyncWebServerRequest::~AsyncWebServerRequest() {
  delete _deferredResponse.exchange(nullptr, std::memory_order_acq_rel);'''),
    ('''void AsyncWebServerRequest::_onPoll() {
  std::shared_ptr<AsyncWebServerRequest> self = _this;  // Ensure we stay in scope over the function''',
     '''void AsyncWebServerRequest::_onPoll() {
  std::shared_ptr<AsyncWebServerRequest> self = _this;  // Ensure we stay in scope over the function
  if (auto *pending = _deferredResponse.exchange(nullptr, std::memory_order_acq_rel)) {
    if (_client && _client->connected()) send(pending);
    else delete pending;
    return;
  }'''),
    ('void AsyncWebServerRequest::send(AsyncWebServerResponse *response) {', '''bool AsyncWebServerRequest::sendDeferred(AsyncWebServerResponse *response) {
  if (!response) return false;
  AsyncWebServerResponse *expected = nullptr;
  return _deferredResponse.compare_exchange_strong(expected, response, std::memory_order_release, std::memory_order_relaxed);
}

void AsyncWebServerRequest::send(AsyncWebServerResponse *response) {'''),
    ('''  if (_tempFile) {
    _tempFile.close();
  }''', '''  if (_tempFile) {
    SR_READ_IO_SCOPE();
    _tempFile.close();
  }'''),
    ('''  AsyncWebServerRequest::beginResponse(FS &fs, const String &path, const char *contentType, bool download, AwsTemplateProcessor callback) {''',
     '''  AsyncWebServerRequest::beginResponse(FS &fs, const String &path, const char *contentType, bool download, AwsTemplateProcessor callback) {
  SR_READ_IO_SCOPE();'''),
]
FILE_HEADER_HASH = 'f7eaba9cbecdb200501955870133b7557259ad9b070f60c8300ecbb79df2c5e6'
FILE_SOURCE_HASH = '77aae7f78eb75b6d08f886b96b55da054360691d9b466fb9d490fcac95e0c7ea'
STATIC_SOURCE_HASH = 'dab7318168f55cac874f9fefdee825966f8427201a8375605175d149f09d0be1'
FILE_HEADER_EDITS = [
    ('#pragma once', '#pragma once\n#include "SimpleRadioReadIoPriority.h"'),
    ('''  ~AsyncFileResponse() {
    _content.close();''', '''  ~AsyncFileResponse() {
    SR_READ_IO_SCOPE();
    _content.close();'''),
]
FILE_SOURCE_EDITS = [
    ('''AsyncFileResponse::AsyncFileResponse(FS &fs, const String &path, const char *contentType, bool download, AwsTemplateProcessor callback)
  : AsyncAbstractResponse(callback) {''', '''AsyncFileResponse::AsyncFileResponse(FS &fs, const String &path, const char *contentType, bool download, AwsTemplateProcessor callback)
  : AsyncAbstractResponse(callback) {
  SR_READ_IO_SCOPE();'''),
    ('''AsyncFileResponse::AsyncFileResponse(File content, const String &path, const char *contentType, bool download, AwsTemplateProcessor callback)
  : AsyncAbstractResponse(callback) {''', '''AsyncFileResponse::AsyncFileResponse(File content, const String &path, const char *contentType, bool download, AwsTemplateProcessor callback)
  : AsyncAbstractResponse(callback) {
  SR_READ_IO_SCOPE();'''),
    ('''size_t AsyncFileResponse::_fillBuffer(uint8_t *data, size_t len) {''', '''size_t AsyncFileResponse::_fillBuffer(uint8_t *data, size_t len) {
  SR_READ_IO_SCOPE();'''),
]
STATIC_SOURCE_EDITS = [
    ('#include "WebHandlerImpl.h"', '#include "WebHandlerImpl.h"\n#include "SimpleRadioReadIoPriority.h"'),
    ('''bool AsyncStaticWebHandler::_getFile(AsyncWebServerRequest *request) const {''', '''bool AsyncStaticWebHandler::_getFile(AsyncWebServerRequest *request) const {
  SR_READ_IO_SCOPE();'''),
    ('''void AsyncStaticWebHandler::handleRequest(AsyncWebServerRequest *request) {''', '''void AsyncStaticWebHandler::handleRequest(AsyncWebServerRequest *request) {
  SR_READ_IO_SCOPE();'''),
]
PATCH_FILES = [('ESPAsyncWebServer.h', DEFERRED_HEADER_HASH, DEFERRED_HEADER_EDITS),
               ('WebRequest.cpp', DEFERRED_SOURCE_HASH, DEFERRED_SOURCE_EDITS),
               ('WebResponseImpl.h', FILE_HEADER_HASH, FILE_HEADER_EDITS),
               ('WebResponses.cpp', FILE_SOURCE_HASH, FILE_SOURCE_EDITS),
               ('WebHandlers.cpp', STATIC_SOURCE_HASH, STATIC_SOURCE_EDITS)]


def clean_source(source, expected_hash, edits):
    import web_flow_patch as flow
    original = flow.strip_request(source.replace('\r\n', '\n'))
    original = flow.strip(original) if flow.MARKER in original else original
    applied = [i for i, (_, new) in enumerate(edits) if new in original]
    if applied:
        # Accept the complete previous three-edit response handoff as a known
        # migration, never arbitrary partial/unknown dependency modifications.
        legacy = expected_hash == DEFERRED_SOURCE_HASH and applied == list(range(3))
        if applied != list(range(len(edits))) and not legacy:
            raise RuntimeError('Deferred HTTP: incomplete existing patch')
        for i in reversed(applied):
            old, new = edits[i]
            if original.count(new) != 1: raise RuntimeError('Deferred HTTP: ambiguous existing patch')
            original = original.replace(new, old)
    if hashlib.sha256(original.encode()).hexdigest() != expected_hash:
        raise RuntimeError('Deferred HTTP: unfamiliar dependency; refusing unchecked patch: expected ' + expected_hash + ', got ' + hashlib.sha256(original.encode()).hexdigest())
    return original


def deferred_patch(source, expected_hash, edits):
    import web_flow_patch as flow
    with_flow = flow.MARKER in source
    original = clean_source(source, expected_hash, edits)
    for old, new in edits:
        if original.count(old) != 1:
            raise RuntimeError('Deferred HTTP: ambiguous patch anchor')
        original = original.replace(old, new)
    if expected_hash in (DEFERRED_HEADER_HASH,DEFERRED_SOURCE_HASH): original=flow.apply_request(original)
    return flow.apply(original) if with_flow else original


def apply_deferred_to_dependency(env):
    folder = Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') / 'ESPAsyncWebServer/src'
    helper = Path(env.subst('$PROJECT_DIR')) / 'src/storage/read_io_priority.h'
    target = folder / 'SimpleRadioReadIoPriority.h'
    if not target.exists() or target.read_bytes() != helper.read_bytes(): target.write_bytes(helper.read_bytes())
    budget = Path(env.subst('$PROJECT_DIR')) / 'src/web/tx_budget.h'
    budget_target = folder / 'SimpleRadioTxBudget.h'
    if not budget_target.exists() or budget_target.read_bytes()!=budget.read_bytes(): budget_target.write_bytes(budget.read_bytes())
    for name, digest, edits in PATCH_FILES:
        file = folder / name
        source = file.read_text(encoding='utf-8')
        try:
            result = deferred_patch(source, digest, edits)
        except RuntimeError as error:
            raise RuntimeError(str(file) + ': ' + str(error)) from error
        if source != result:
            file.write_text(result, encoding='utf-8', newline='\n')
    print('SimpleRadio web: network-owned replies; scoped static file I/O; pinned source verified')


if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        apply_deferred_to_dependency(env)
