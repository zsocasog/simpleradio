"""Compare two recorded runs without choosing or deploying an optimization."""
import argparse
import json
from pathlib import Path
from stress_report import summarize

def load(directory):
    events=[json.loads(line) for line in (directory/'events.jsonl').read_text(encoding='utf-8').splitlines()]
    summary=summarize(events)
    builds=sorted({e['buildId'] for e in events if e['kind']=='sample'})
    manifest=next((e for e in events if e['kind']=='manifest'),{})
    return dict(summary=summary,builds=builds,seed=manifest.get('seed'),runnerHashes=manifest.get('runnerHashes',{}),reference=manifest.get('referenceSha256'))

def compare(a,b):
    phases=sorted({row['phase'] for run in (a,b) for row in run['summary']['feedBalance']})
    rows=[]
    for phase in phases:
        result=dict(phase=phase)
        for name,run in (('before',a),('after',b)):
            balances=[row for row in run['summary']['feedBalance'] if row['phase']==phase]
            seconds=sum(row['seconds'] for row in balances)
            deficit=sum(row['conservativeDeficitMs'] for row in balances)
            requests=run['summary']['latency'].get(phase+' / station-image',{})
            saves=run['summary']['latency'].get(phase+' / settings-save',{})
            result[name]=dict(seconds=round(seconds,2),deficitMs=round(deficit,1),
                              deficitMsPerMinute=round(deficit*60/seconds,1) if seconds else None,
                              imageCount=requests.get('count',0),imageP95Ms=requests.get('p95Ms'),
                              saveCount=saves.get('count',0),saveMedianMs=saves.get('p50Ms'),saveMaxMs=saves.get('maxMs'))
        rows.append(result)
    return dict(beforeBuilds=a['builds'],afterBuilds=b['builds'],sameSeed=a['seed']==b['seed'],
                sameRunner=bool(a['runnerHashes'] and a['runnerHashes']==b['runnerHashes']),
                sameControlledReference=bool(a['reference'] and a['reference']==b['reference']),
                beforeResult=a['summary']['result'],afterResult=b['summary']['result'],
                beforeMinimumHeap=a['summary']['minimumHeap'],afterMinimumHeap=b['summary']['minimumHeap'],phases=rows)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('before',type=Path);parser.add_argument('after',type=Path);parser.add_argument('--out',type=Path)
    args=parser.parse_args();result=compare(load(args.before),load(args.after));text=json.dumps(result,ensure_ascii=False,indent=2)
    if args.out:args.out.write_text(text+'\n',encoding='utf-8')
    print(text)
