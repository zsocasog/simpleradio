"""Offline analysis of stress events. Missing telemetry is never a pass."""
import json
import math
from pathlib import Path

def percentile(values, percent):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * percent / 100) - 1)] if values else None

def summarize(events):
    requests = [e for e in events if e['kind'] == 'http']
    samples = [e for e in events if e['kind'] == 'sample']
    findings = [e for e in events if e['kind'] in ('failure', 'audio-risk', 'audio-failure', 'reboot')]
    groups = {}
    for e in requests:
        key = e.get('requestPhase', e.get('phase', '')) + ' / ' + e['operation']
        groups.setdefault(key, []).append(e)
    latency = {key: dict(count=len(rows), p50Ms=percentile([r['ms'] for r in rows], 50),
                        p95Ms=percentile([r['ms'] for r in rows], 95),
                        p99Ms=percentile([r['ms'] for r in rows], 99),
                        maxMs=max(r['ms'] for r in rows),
                        errors=sum(not r.get('ok', False) for r in rows)) for key, rows in groups.items()}
    measured = [s for s in samples if s.get('audio') is not None]
    stable = [s for s in measured if s.get('stable') and s['audio'].get('active')]
    expected_phases = {e['phase'] for e in events if e['kind']=='phase' and e.get('expectsAudio')}
    coverage = {phase: dict(stableSamples=sum(s.get('phase')==phase for s in stable),
                            codecs=sorted({s.get('codec','') for s in samples if s.get('phase')==phase and s.get('codec')}))
                for phase in expected_phases}
    balances = feed_balances(samples)
    findings += [dict(kind='audio-risk',phase=row['phase'],detail='Conservative digital feed deficit',
                      milliseconds=row['conservativeDeficitMs']) for row in balances if row['conservativeDeficitMs'] > 1]
    fails = [e for e in findings if e['kind'] != 'audio-risk']
    result = 'FAIL' if fails else 'OBSERVED_WITH_RISKS' if findings else 'NO_FAILURE_OBSERVED'
    if not stable and not fails: result = 'INCONCLUSIVE_AUDIO'
    elif any(row['stableSamples'] < 2 for row in coverage.values()) and not fails: result = 'INCONCLUSIVE_COVERAGE'
    finished=[e for e in events if e['kind']=='finished']
    exercise=any(e['kind']=='manifest' and e.get('exercise') for e in events)
    if exercise and not fails and (not finished or not finished[-1].get('completed')): result='INCOMPLETE'
    return dict(result=result, requests=len(requests), samples=len(samples), stableAudioSamples=len(stable),
                minimumHeap=min((s['heapFree'] for s in samples), default=None),
                minimumLargestBlock=min((s['heapLargest'] for s in samples), default=None),
                minimumPsram=min((s['psramFree'] for s in samples), default=None),
                findings=findings, latency=latency, phaseCoverage=coverage, feedBalance=balances,
                limits=['API-level user simulation; no physical encoder/IR or browser DOM test.',
                        'Muted digital-output timing is not an acoustic quality measurement.',
                        'Feed deadline misses indicate starvation risk, not content-aware dropout detection.',
                        'Natural radio gaps cannot be separated from source faults without a controlled fixture.',
                        'Sampled minima are not continuous minima. heapMinFree is not simultaneous free heap.'])

def write_report(directory, events):
    directory = Path(directory)
    summary = summarize(events)
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    lines = ['# SimpleRadio terheléses mérés', '', '**Eredmény: ' + summary['result'] + '**', '',
             f"HTTP kérések: {summary['requests']}; állapotminták: {summary['samples']}; stabil hangmérési minták: {summary['stableAudioSamples']}.", '',
             f"Mintavételezett legkisebb belső szabad RAM: {summary['minimumHeap']} B; legnagyobb egybefüggő blokk minimuma: {summary['minimumLargestBlock']} B.", '',
             '| Szakasz / művelet | Darab | p50 ms | p95 ms | maximum ms | Hibák |',
             '|---|---:|---:|---:|---:|---:|']
    for key, row in summary['latency'].items():
        lines.append(f"| {key} | {row['count']} | {row['p50Ms']} | {row['p95Ms']} | {row['maxMs']} | {row['errors']} |")
    lines += ['', '## Lefedettség', '', '```json', json.dumps(summary['phaseCoverage'],ensure_ascii=False,indent=2),'```']
    lines += ['', '## Digitális hangadat-egyenleg', '',
              'Csak megszakítás nélküli stabil mintasorok. A pozitív hiány kockázati jel; a becslés két teljes DMA-gyűrűt és az észlelt maximális írásidőt is levonja. Némítva ez sem akusztikai mérés.', '',
              '| Szakasz | Ablak s | Küldött és beadott adat különbsége ms | Konzervatív hiánybecslés ms |',
              '|---|---:|---:|---:|']
    for row in summary['feedBalance']:
        lines.append(f"| {row['phase']} | {row['seconds']} | {row['differenceMs']} | {row['conservativeDeficitMs']} |")
    lines += ['', '## Események', '']
    lines += ['- ' + json.dumps(e, ensure_ascii=False) for e in summary['findings']] or ['- Nem észleltünk hibát a lefuttatott forgatókönyvekben.']
    lines += ['', '## Értelmezési korlátok', ''] + ['- ' + line for line in summary['limits']]
    (directory / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return summary

def feed_balances(samples):
    groups=[]; current=[]
    for s in samples:
        a=s.get('audio')
        if not s.get('stable') or not a or not a.get('active'):
            if current: groups.append(current);current=[]
            continue
        if current:
            p=current[-1];b=p['audio']
            if (s.get('phase'),a['epoch'],a['sampleRate'],s.get('codec'),s.get('stationId')) != (p.get('phase'),b['epoch'],b['sampleRate'],p.get('codec'),p.get('stationId')):
                groups.append(current);current=[]
        current.append(s)
    if current:groups.append(current)
    rows=[]
    for group in groups:
        if len(group)<3:continue
        a,b=group[0]['audio'],group[-1]['audio'];rate=b['sampleRate']
        if not rate or b['sentFrames']<a['sentFrames'] or b['acceptedBytes']<a['acceptedBytes']:continue
        difference=b['sentFrames']-a['sentFrames']-(b['acceptedBytes']-a['acceptedBytes'])/8
        # Initial queued frames plus an in-flight write at the end are bounded
        # conservatively by TWO rings and the longest observed write interval.
        margin=2*b['dmaFrames']+rate*max(x['audio']['writeMaxUs'] for x in group)/1000000
        rows.append(dict(phase=group[0].get('phase',''),seconds=round(group[-1]['t']-group[0]['t'],3),
                         differenceMs=round(difference*1000/rate,1),
                         conservativeDeficitMs=round(max(0,difference-margin)*1000/rate,1)))
    return rows

class AudioAudit:
    def __init__(self): self.previous = None

    def observe(self, sample):
        old = self.previous; self.previous = sample
        if not old: return []
        if sample['uptimeMs'] < old['uptimeMs'] and old['uptimeMs'] - sample['uptimeMs'] < 0x80000000:
            return [dict(kind='reboot', detail='Device uptime decreased')]
        a, b = old.get('audio'), sample.get('audio')
        if not a or not b or not old.get('stable') or not sample.get('stable'): return []
        if a['epoch'] != b['epoch']:
            return [dict(kind='audio-risk', detail='Unexpected I2S epoch change in a stable phase')]
        if not a.get('active') or not b.get('active'): return [dict(kind='audio-failure', detail='I2S inactive during expected stable playback')]
        found = []
        # The sent counter advances even for DMA-inserted zero samples. It
        # establishes clock progress, never that valid music reached the DAC.
        if b['sentFrames'] <= a['sentFrames']:
            found.append(dict(kind='audio-failure', detail='I2S output counter stopped'))
        if b['feedDeadlineMisses'] > a['feedDeadlineMisses']:
            found.append(dict(kind='audio-risk', detail='No accepted write for longer than the DMA ring',
                              count=b['feedDeadlineMisses'] - a['feedDeadlineMisses']))
        if b['writeErrors'] > a['writeErrors']:
            found.append(dict(kind='audio-failure', detail='I2S driver write error'))
        return found

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    events = [json.loads(line) for line in (args.directory / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
    print(json.dumps(write_report(args.directory, events), ensure_ascii=False, indent=2))
