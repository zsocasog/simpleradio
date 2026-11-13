#pragma once
#include <atomic>
#include <utility>

// The job supplies an atomic reference count initially zero. One allocation
// owns the job and its control state; copying a queued/callback lease cannot
// allocate another control block or fail under network-memory pressure.
template<class Job> class JobPtr {
public:
  explicit JobPtr(Job* job = nullptr) : job_(job) { retain(); }
  JobPtr(const JobPtr& other) : job_(other.job_) { retain(); }
  JobPtr(JobPtr&& other) noexcept : job_(other.job_) { other.job_ = nullptr; }
  ~JobPtr() { if (job_ && job_->references.fetch_sub(1) == 1) delete job_; }
  JobPtr& operator=(JobPtr other) { swap(other); return *this; }
  void swap(JobPtr& other) noexcept { std::swap(job_, other.job_); }
  Job* get() const { return job_; }
  Job* operator->() const { return job_; }
  explicit operator bool() const { return job_ != nullptr; }
private:
  void retain() { if (job_) job_->references.fetch_add(1); }
  Job* job_;
};
