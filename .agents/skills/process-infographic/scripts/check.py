"""Small invariant check using fictional data; no personal records."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import xml.etree.ElementTree as ET
from render import prepare, render

data = dict(width=1200,height=600,title='Private Co pipeline',public_title='Process',
            sensitive_terms=['Private Co','REQ-123'], nodes=[
    dict(id='s',x=80,y=260,label='Invited',public_label='Invited',color='#d96fba',placement='above'),
    dict(id='r',x=450,y=260,label='Round 1',public_label='Round 1',color='#16a9b6',placement='above'),
    dict(id='w',x=850,y=220,label='Waiting',public_label='Waiting',details=['Private Co / REQ-123'],color='#8b969e'),
    dict(id='e',x=850,y=400,label='Rejected',public_label='Rejected',color='#d66b69')],records=[
    dict(id='secret-id-1',path=['s','r','w'],sources=['private source']),
    dict(id='secret-id-2',path=['s','r','e'],sources=['private source'],weight=2)])
nodes,counts,edges = prepare(data)
assert counts == {'s':3,'r':3,'w':1,'e':2} and edges['s','r'] == 3
merged = deepcopy(data)
merged['nodes'].append(dict(id='a',x=450,y=360,label='Assessment',public_label='Assessment',color='#16a9b6'))
merged['records'].append(dict(id='secret-id-3',path=['s','a','w'],sources=['private source']))
_,merged_counts,merged_edges = prepare(merged)
assert merged_counts['s'] == 4 and merged_counts['w'] == 2
assert merged_edges['r','w'] == merged_edges['a','w'] == 1
with TemporaryDirectory() as directory:
    root = Path(directory)
    render(data,root)
    full = ET.parse(root/'process-full.svg').getroot()
    anon = ET.parse(root/'process-anonymous.svg').getroot()
    geometry = lambda doc: [(e.tag,e.attrib) for e in doc if not e.tag.endswith('text')]
    assert geometry(full) == geometry(anon)
    public = (root/'process-anonymous.svg').read_text()
    assert all(value not in public for value in ['Private Co','REQ-123','secret-id','private source'])
    assert (root/'process-anonymous.png').stat().st_size > 1000
    bad = deepcopy(data)
    bad['nodes'][2]['public_details'] = ['Private Co']
    try:
        render(bad,root/'blocked')
    except ValueError:
        assert not (root/'blocked').exists()
    else:
        raise AssertionError('Sensitive public label accepted')
for fault in ('duplicate', 'unknown', 'unfinished', 'missing-public-label'):
    bad = deepcopy(data)
    if fault == 'duplicate': bad['records'].append(bad['records'][0])
    if fault == 'unknown': bad['records'][0]['path'][-1] = 'missing'
    if fault == 'unfinished':
        bad['records'][0]['path'] = ['s','r']
        bad['nodes'] = [n for n in bad['nodes'] if n['id'] != 'w']
    if fault == 'missing-public-label': del bad['nodes'][0]['public_label']
    try:
        prepare(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f'Invalid input accepted: {fault}')
print('PASS: counts, conservation, identity, public-label isolation, matching geometry, SVG and PNG')
