#pragma once
#ifndef SIMPLE_RADIO_TX_BUDGET_H
#define SIMPLE_RADIO_TX_BUDGET_H
#include <atomic>
#include <stddef.h>
#include <stdint.h>

// Audio setup briefly needs the same internal Wi-Fi memory as outgoing HTTP.
// Give it a bounded quiet window, including the decoder's first loop. A slow
// or unreachable station cannot hold the WebUI indefinitely.
class AudioHttpWindow {
public:
  void begin(uint32_t now) { started_.store(now); active_.store(true); }
  bool blocked(uint32_t now) const {
    return active_.load() && static_cast<uint32_t>(now - started_.load()) < 1500U;
  }
private:
  std::atomic<uint32_t> started_{0};
  std::atomic<bool> active_{false};
};
inline AudioHttpWindow& responseAudioWindow() { static AudioHttpWindow window; return window; }

// Intrusive, allocation-free FIFO. The network task guards these short list
// operations with its cross-core critical section; no client is called inside.
struct ResponseTxTurn { ResponseTxTurn* next = nullptr; void* owner = nullptr; bool waiting = false; };
class ResponseTxQueue {
public:
  ResponseTxTurn* front() const { return head_; }
  bool enter(ResponseTxTurn* turn) {
    if (!turn->waiting) {
      turn->waiting = true;
      turn->next = nullptr;
      if (tail_) tail_->next = turn;
      else head_ = turn;
      tail_ = turn;
    }
    return head_ == turn;
  }
  void remove(ResponseTxTurn* turn) {
    if (!turn->waiting) return;
    ResponseTxTurn* previous = nullptr;
    for (auto* current = head_; current; current = current->next) {
      if (current == turn) {
        if (previous) previous->next = current->next;
        else head_ = current->next;
        if (tail_ == current) tail_ = previous;
        turn->next = nullptr;
        turn->waiting = false;
        return;
      }
      previous = current;
    }
  }
private:
  ResponseTxTurn* head_ = nullptr;
  ResponseTxTurn* tail_ = nullptr;
};

// A short header still needs a full packet buffer. Normal traffic leaves
// room for Wi-Fi copies; a low-water single packet must be allowed to drain
// the waiting requests themselves instead of reserving their RAM forever.
// ESP.getFreeHeap() also includes internal memory with different capabilities.
inline size_t responseTxMemoryAllowance(size_t wanted, size_t freeDma, size_t largestDma, size_t mss, size_t outstanding) {
  if (freeDma < mss + 1536U || largestDma < mss + 512U) return 0;
  // Waiting responses themselves retain memory. When the normal reserve is
  // unavailable, a single packet must still be able to drain and free them.
  // Do not refill it until its real ACK has released every outstanding byte.
  if (freeDma < 8192U + 2U * (mss + 256U) && outstanding) return 0;
  return wanted < mss ? wanted : mss;
}

// Allocation-free byte accounting. Requests retain their outstanding charge
// until the real TCP ACK/disconnect, independently of response/source lifetime.
class SharedTxBudget {
public:
  size_t used() const { return used_.load(); }
  size_t reserve(size_t wanted, size_t limit) {
    for (;;) {
      size_t current = used_.load();
      if (current >= limit) return 0;
      const size_t available = limit - current;
      const size_t granted = wanted < available ? wanted : available;
      if (used_.compare_exchange_weak(current, current + granted)) return granted;
    }
  }
  void charge(size_t bytes) { used_.fetch_add(bytes); }
  size_t release(size_t bytes) {
    for (;;) {
      size_t current = used_.load();
      const size_t released = bytes < current ? bytes : current;
      if (used_.compare_exchange_weak(current, current - released)) return released;
    }
  }
private:
  std::atomic<size_t> used_{0};
};

// Cross-core handoff: a saver first holds new writers, then waits for a writer
// which had already entered to leave. After hold()+quiet(), no new TCP buffer
// allocation can race its memory check. Holds are counted across job cleanup.
class ResponseTxGate {
public:
  bool enter() {
    writers_.charge(1);
    if (!holds_.used()) return true;
    writers_.release(1);
    return false;
  }
  void leave() { writers_.release(1); }
  void hold() { holds_.charge(1); }
  void release() { holds_.release(1); }
  bool quiet() const { return !writers_.used(); }
  size_t holds() const { return holds_.used(); }
private:
  SharedTxBudget holds_, writers_;
};

class ResponseTxPermit {
public:
  explicit ResponseTxPermit(ResponseTxGate& gate) : gate_(gate), acquired_(gate.enter()) {}
  ~ResponseTxPermit() { if (acquired_) gate_.leave(); }
  ResponseTxPermit(const ResponseTxPermit&) = delete;
  ResponseTxPermit& operator=(const ResponseTxPermit&) = delete;
  bool acquired() const { return acquired_; }
private:
  ResponseTxGate& gate_;
  bool acquired_;
};
inline SharedTxBudget& responseSharedBytes() { static SharedTxBudget bytes; return bytes; }
inline ResponseTxGate& responseSharedGate() { static ResponseTxGate gate; return gate; }
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#include <esp_timer.h>
struct ResponseTxTimings {
  std::atomic<uint32_t> addMaxMs{0}, sendMaxMs{0};
  std::atomic<uint32_t> dataMaxMs{0}, ackMaxMs{0}, pollMaxMs{0}, disconnectMaxMs{0};
  static void record(std::atomic<uint32_t>& maximum, uint32_t value) {
    uint32_t previous = maximum.load();
    while (value > previous && !maximum.compare_exchange_weak(previous, value)) {}
  }
};
inline ResponseTxTimings& responseTxTimings() { static ResponseTxTimings times; return times; }
class ResponseCallbackTimer {
public:
  explicit ResponseCallbackTimer(std::atomic<uint32_t>& maximum) : maximum_(maximum), started_(esp_timer_get_time()) {}
  ~ResponseCallbackTimer() { ResponseTxTimings::record(maximum_, static_cast<uint32_t>((esp_timer_get_time() - started_) / 1000)); }
private:
  std::atomic<uint32_t>& maximum_;
  int64_t started_;
};
#endif
#endif
