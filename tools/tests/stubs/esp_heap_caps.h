#pragma once
#include <stddef.h>
#include <stdint.h>
// Declaration-only backend for compile-checking the real JSON/allocator API.
constexpr uint32_t MALLOC_CAP_SPIRAM = 1;
constexpr uint32_t MALLOC_CAP_8BIT = 2;
void* heap_caps_malloc(size_t, uint32_t);
void* heap_caps_realloc(void*, size_t, uint32_t);
void heap_caps_free(void*);
size_t heap_caps_get_allocated_size(void*);
size_t heap_caps_get_free_size(uint32_t);
