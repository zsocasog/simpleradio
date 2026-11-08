#pragma once

#include <stdint.h>

namespace PickerLogo {
// Bounded single-request handoff. The caller serializes these short pointer
// operations; allocation, filesystem access and destruction happen outside it.
template<class Job> class Mailbox {
public:
  struct Retired { Job* pending; Job* completed; };

  constexpr uint32_t enqueue(Job* job) {
    if (!job || busy()) return 0;
    nextTicket();
    job->ticket = ticket_;
    pending_ = job;
    return ticket_;
  }
  constexpr bool busy() const { return pending_ || completed_ || working_; }
  constexpr bool pending() const { return pending_ != nullptr; }
  constexpr bool current(uint32_t ticket) const { return ticket && ticket == ticket_; }
  constexpr Job* claim() {
    if (!pending_ || working_) return nullptr;
    Job* job = pending_;
    pending_ = nullptr;
    working_ = true;
    workingTicket_ = job->ticket;
    return job;
  }
  // Return a rejected result to its worker for destruction. A cancelled worker
  // always retains its private buffer until it stops using it.
  constexpr Job* finish(Job* job) {
    if (!job || !working_ || workingTicket_ != job->ticket) return job;
    working_ = false;
    if (!current(job->ticket) || completed_) return job;
    completed_ = job;
    return nullptr;
  }
  constexpr Job* take(uint32_t ticket) {
    if (!completed_ || !current(ticket) || completed_->ticket != ticket) return nullptr;
    Job* job = completed_;
    completed_ = nullptr;
    return job;
  }
  constexpr Retired cancel() {
    nextTicket();
    const Retired retired{pending_, completed_};
    pending_ = nullptr;
    completed_ = nullptr;
    return retired;
  }

private:
  constexpr void nextTicket() { if (++ticket_ == 0) ++ticket_; }
  uint32_t ticket_ = 0;
  uint32_t workingTicket_ = 0;
  Job* pending_ = nullptr;
  Job* completed_ = nullptr;
  bool working_ = false;
};
} // namespace PickerLogo
