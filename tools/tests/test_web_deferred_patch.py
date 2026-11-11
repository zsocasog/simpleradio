import hashlib
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools'))
import patch_web_deferred as patch

class DeferredPatchTests(unittest.TestCase):
    def sources(self):
        folder=ROOT/'.pio/libdeps/esp32-s3-devkitc1-n16r8/ESPAsyncWebServer/src'
        for name,digest,edits in patch.PATCH_FILES:
            source=(folder/name).read_text(encoding='utf-8')
            source=patch.clean_source(source,digest,edits)
            self.assertEqual(hashlib.sha256(source.encode()).hexdigest(),digest)
            yield source,digest,edits

    def test_only_reviewed_blocks_change_and_repeated_builds_are_identical(self):
        for source,digest,edits in self.sources():
            changed=patch.deferred_patch(source,digest,edits)
            self.assertEqual(patch.deferred_patch(changed,digest,edits),changed)
            self.assertEqual(patch.deferred_patch(source.replace('\n','\r\n'),digest,edits),changed)
            for old,new in reversed(edits):changed=changed.replace(new,old)
            self.assertEqual(changed,source)

    def test_unknown_dependency_and_partial_patch_are_rejected(self):
        for source,digest,edits in self.sources():
            with self.assertRaises(RuntimeError):patch.deferred_patch(source+'// changed\n',digest,edits)
            partial=source.replace(*edits[0])
            with self.assertRaises(RuntimeError):patch.deferred_patch(partial,digest,edits)

    def test_handoff_has_one_atomic_owned_pointer_and_no_extra_task_or_payload_copy(self):
        changes='\n'.join(new for _,new in patch.DEFERRED_HEADER_EDITS+patch.DEFERRED_SOURCE_EDITS)
        self.assertIn('std::atomic<AsyncWebServerResponse *> _deferredResponse{nullptr}',changes)
        self.assertIn('std::memory_order_release',changes)
        self.assertIn('std::memory_order_acq_rel',changes)
        self.assertNotIn('xTaskCreate',changes)
        self.assertNotIn('malloc',changes)

    def test_previous_complete_handoff_migrates_but_unrelated_partial_patches_still_fail(self):
        source,digest,edits=next(item for item in self.sources() if item[1]==patch.DEFERRED_SOURCE_HASH)
        legacy=source
        for old,new in edits[:3]:legacy=legacy.replace(old,new)
        self.assertEqual(patch.deferred_patch(legacy,digest,edits),patch.deferred_patch(source,digest,edits))

    def test_all_static_open_read_and_close_paths_use_the_same_scoped_priority_as_station_images(self):
        text='\n'.join(new for _,_,edits in patch.PATCH_FILES for _,new in edits)
        self.assertEqual(text.count('SR_READ_IO_SCOPE();'),8)
        self.assertNotIn('CONFIG_ASYNC_TCP_PRIORITY',text)
        self.assertNotIn('vTaskPrioritySet',text)  # existing scoped helper owns restoration

if __name__=='__main__':unittest.main()
