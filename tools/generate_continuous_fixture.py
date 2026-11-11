"""Generate a repeatable, non-silent FLAC/Ogg stress source with desktop FFmpeg.

The FFmpeg executable is supplied explicitly; no radio dependency is changed.
Outputs belong in an ignored measurement directory, e.g. .pio/reference/run-1.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import struct

def audit(ffmpeg, path):
    process=subprocess.Popen([str(ffmpeg),'-hide_banner','-loglevel','error','-i',str(path),
                              '-f','s16le','-acodec','pcm_s16le','pipe:1'],stdout=subprocess.PIPE)
    digest=hashlib.sha256();frames=0;zero_run=0;longest=0;carry=b''
    while True:
        block=process.stdout.read(262144)
        if not block:break
        digest.update(block);block=carry+block;end=len(block)//4*4;carry=block[end:]
        for left,right in struct.iter_unpack('<hh',block[:end]):
            frames+=1
            zero_run=zero_run+1 if left==0 and right==0 else 0
            longest=max(longest,zero_run)
    process.stdout.close()
    if process.wait()!=0 or carry:raise RuntimeError('Reference decoding failed')
    if longest>=256:raise RuntimeError('Reference contains silent DMA-sized runs')
    return dict(frames=frames,maxZeroRunFrames=longest,pcmSha256=digest.hexdigest())

def generate(ffmpeg, directory, seconds=600):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=False)
    flac=directory/'continuous.flac';ogg=directory/'continuous.ogg'
    noise=f'anoisesrc=color=pink:amplitude=0.06:sample_rate=44100:duration={seconds}:seed=20261111'
    tones=f'aevalsrc=(0.65+0.35*sin(2*PI*2.37*t))*(0.12*sin(2*PI*73*t)+0.08*sin(2*PI*401*t)+0.05*sin(2*PI*1777*t)+0.035*sin(2*PI*6001*t)):s=44100:d={seconds}'
    base=[str(ffmpeg),'-hide_banner','-loglevel','error','-n']
    subprocess.run(base+['-f','lavfi','-i',noise,'-f','lavfi','-i',tones,
        '-filter_complex','[0:a][1:a]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0',
        '-sample_fmt','s16','-c:a','flac','-compression_level','5','-map_metadata','-1',str(flac)],check=True)
    subprocess.run(base+['-i',str(flac),'-c:a','copy','-map_metadata','-1','-fflags','+bitexact',str(ogg)],check=True)
    version=subprocess.check_output([str(ffmpeg),'-version'],text=True).splitlines()[0]
    result=dict(seconds=seconds,sampleRate=44100,channels=2,seed=20261111,ffmpeg=version,
        files={p.name:dict(bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in (flac,ogg)})
    result['audit']={p.name:audit(ffmpeg,p) for p in (flac,ogg)}
    if result['audit'][flac.name]!=result['audit'][ogg.name]:raise RuntimeError('Container PCM differs')
    (directory/'manifest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--seconds',type=int,default=600)
    args=parser.parse_args()
    if args.seconds<=0:parser.error('Duration must be positive')
    print(json.dumps(generate(args.ffmpeg,args.out,args.seconds)))
