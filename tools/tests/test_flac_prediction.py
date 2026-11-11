"""Check the patch and compile arithmetic equivalence on the actual S3 compiler."""
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
import patch_audio_flac_prediction as patch


class PredictionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/flac_decoder/flac_decoder.cpp').read_text(encoding='utf-8').replace(patch.FAST, '')

    def test_idempotent_and_original_checked_path_retained(self):
        changed = patch.patch_source(self.source)
        self.assertEqual(changed.replace(patch.FAST, ''), self.source)
        self.assertEqual(patch.patch_source(changed), changed)

    def test_unknown_changed_missing_duplicate_or_partial_patch_rejected(self):
        f = re.search(r'(?ms)^void FlacDecoder::restoreLinearPrediction\(.*?^}', self.source).group()
        for altered in (self.source.replace(f, ''), self.source + '\n' + f,
                        self.source.replace('sum >> shift', 'sum << shift', 1),
                        patch.patch_source(self.source).replace('j < order', 'j <= order', 1)):
            with self.assertRaises(RuntimeError):
                patch.patch_source(altered)

    def test_actual_pinned_buffer_byte_semantics_are_verified_before_patching(self):
        header=(ROOT/'.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/psram_unique_ptr.hpp').read_text(encoding='utf-8')
        patch.verify_buffer_header(header)
        with self.assertRaises(RuntimeError):
            patch.verify_buffer_header(header.replace('allocated_size = size;', 'allocated_size = size / sizeof(T);', 1))

    def test_actual_s3_arithmetic_and_short_span_fallback(self):
        compiler = shutil.which('xtensa-esp32s3-elf-g++')
        if not compiler:
            candidate = Path.home() / '.platformio/packages/toolchain-xtensa-esp-elf/bin/xtensa-esp32s3-elf-g++.exe'
            if candidate.is_file(): compiler = str(candidate)
        if not compiler: self.skipTest('Install the project PlatformIO S3 toolchain')
        before = re.search(r'(?ms)^void FlacDecoder::restoreLinearPrediction\(.*?^}', self.source).group()
        after = re.search(r'(?ms)^void FlacDecoder::restoreLinearPrediction\(.*?^}', patch.patch_source(self.source)).group()
        def member(function, name):
            return function.replace('void FlacDecoder::restoreLinearPrediction', 'constexpr void ' + name)
        fixture = '''#include <array>
#include <cstdint>
#include <cstddef>
#define FLAC_MAX_CHANNELS 2
struct Samples {
 std::array<int64_t,256> values{}; size_t allocated=256; int errors=0, checks=0; int64_t dummy=0;
 constexpr int64_t* get(){return values.data();}
 // The real pinned ps_ptr reports allocated BYTES (including in operator[]).
 constexpr size_t size(){return allocated*sizeof(int64_t);}
 constexpr int64_t& operator[](size_t i){++checks;if(i<size())return values[i];++errors;return dummy;}
};
struct Coefficients {
 std::array<int32_t,32> values{}; int32_t length=0;
 constexpr int32_t size(){return length;}
 constexpr const int32_t* data(){return values.data();}
 constexpr int32_t operator[](int32_t i){return values[i];}
};
struct Decoder { Samples m_samplesBuffer[2]; Coefficients coefs; int32_t m_numOfOutSamples=0;
''' + member(before, 'original') + '\n' + member(after, 'optimized') + '''
};
constexpr bool compare(unsigned shift) {
 for(int order: {0,1,2,4,8,16,32}) for(int count: {0,1,32,127,256}) for(unsigned ch: {0,1}) {
  Decoder a; a.coefs.length=order; a.m_numOfOutSamples=count;
  for(int j=0;j<order;j++)a.coefs.values[j]=(j%3-1)*1023;
  std::array<int64_t,256> expected{};
  for(int i=0;i<count;i++)expected[i]=(int64_t(i*7919%65536)-32768)*1024;
  for(int i=0;i<count;i++) {
   int64_t prediction=0;
   if(i>=order)for(int j=0;j<order;j++)prediction+=expected[i-1-j]*a.coefs.values[j];
   a.m_samplesBuffer[ch].values[i]=expected[i]-(prediction>>shift);
  }
  Decoder b=a;a.original(ch,shift);b.optimized(ch,shift);
  if(a.m_samplesBuffer[ch].values!=b.m_samplesBuffer[ch].values)return false;
  if(a.m_samplesBuffer[ch].values!=expected)return false;
  if(b.m_samplesBuffer[ch].checks!=0)return false;
 }
 return true;
}
constexpr bool short_span() {
 Decoder a; a.coefs.length=4;a.coefs.values[0]=2;a.coefs.values[1]=-1;
 a.m_numOfOutSamples=20;a.m_samplesBuffer[0].allocated=12;
 for(int i=0;i<20;i++)a.m_samplesBuffer[0].values[i]=i;
 Decoder b=a;a.original(0,1);b.optimized(0,1);
 return a.m_samplesBuffer[0].values==b.m_samplesBuffer[0].values &&
        a.m_samplesBuffer[0].errors==b.m_samplesBuffer[0].errors &&
        a.m_samplesBuffer[0].checks==b.m_samplesBuffer[0].checks &&
        a.m_samplesBuffer[0].dummy==b.m_samplesBuffer[0].dummy;
}
static_assert(compare(0));static_assert(compare(1));static_assert(compare(8));
static_assert(compare(15));static_assert(compare(31));static_assert(short_span());
'''
        output = ROOT / '.pio/tests/flac-prediction'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            source = Path(directory) / 'fixture.cpp'; source.write_text(fixture, encoding='utf-8')
            result = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror',
                                     '-fconstexpr-ops-limit=100000000', '-c', str(source),
                                     '-o', str(Path(directory)/'fixture.o')], cwd=ROOT,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
