#!/usr/bin/env python3
"""Isolated end-to-end PERM acceptance; workbook creation is synthetic only."""
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--artifact', default='e2e')
a = p.parse_args()
assert '/' not in a.artifact and '..' not in a.artifact
OUT = ROOT / '.local/perm-history' / a.artifact
for part in [OUT, *OUT.parents]:
    if part.is_symlink(): raise ValueError('E2E artifact paths cannot traverse symlinks')
OUT.mkdir(parents=True, exist_ok=True)
BOX = OUT / 'checkout'
if BOX.exists(): shutil.rmtree(BOX)
(BOX / 'src').mkdir(parents=True, exist_ok=True)
TOOL = ROOT / 'src/perm-history.py'
if TOOL.exists(): shutil.copyfile(TOOL, BOX / 'src/perm-history.py')
DATA = BOX / '.local/perm-history/downloads'
DATA.mkdir(parents=True, exist_ok=True)
commands, assertions = [], []
def save():
    (OUT/'receipt.json').write_text(json.dumps({'status':'COMPLETE' if assertions and all(x['passed'] for x in assertions) else 'FAILED','commands':commands,'assertions':assertions}, indent=2)+'\n')
def check(name, truth):
    assertions.append({'name':name,'passed':bool(truth)}); save()
    assert truth, name
def run(*args, ok=True, payload=None, seed=None):
    r = subprocess.run([sys.executable,str(BOX/'src/perm-history.py'),*args],capture_output=True,text=True,
        input=json.dumps(payload) if payload is not None else None,
        env={**os.environ, 'PYTHONHASHSEED':str(seed)} if seed is not None else None)
    commands.append({'args':args,'returncode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}); save()
    check('command '+ ' '.join(args)+' expected '+str(ok), (r.returncode == 0) == ok)
    return json.loads(r.stdout) if ok else r
HEAD = ['CASE_NUMBER','CASE_STATUS','RECEIVED_DATE','DECISION_DATE','EMP_BUSINESS_NAME','EMP_TRADE_NAME','EMP_CITY','EMP_STATE','JOB_TITLE','PWD_SOC_CODE','PWD_SOC_TITLE','PRIMARY_WORKSITE_CITY','PRIMARY_WORKSITE_STATE','IS_MULTIPLE_LOCATIONS','ATTY_AG_LAW_FIRM_NAME','ATTY_AG_LAST_NAME','ATTY_AG_FIRST_NAME','ATTY_AG_MIDDLE_NAME']
def row(case,status='Certified',received='2024-01-01',decision='2025-01-01',company='Acme, Inc.',trade='',city='Seattle'):
    return [case,status,received,decision,company,trade,city,'WA','Engineer','15-1252','Software Developers',city,'WA','Y','Law Firm','Public','Agent','']
def workbook(name,rows,headers=HEAD):
    f=DATA/name; w=Workbook(); s=w.active; s.title='PERM'; s.append(headers)
    for r in rows:s.append(r)
    w.save(f); w.close(); return f
def manifest(rows25, rows26, *, name='sources', headers=HEAD):
    sources=[]
    for fy,q,rows in [(2025,4,rows25),(2026,3,rows26)]:
        x=workbook(f'{name}-{fy}.xlsx',rows,headers); pdf=DATA/f'{name}-{fy}.pdf';pdf.write_bytes(b'%PDF-1.4\nsynthetic layout\n%%EOF')
        sources.append({'fiscal_year':fy,'quarter':q,'coverage_start':f'{fy-1}-10-01','coverage_end':f'{fy}-09-30' if q==4 else f'{fy}-06-30','xlsx':{'path':str(x),'url':f'https://www.dol.gov/{name}-{fy}.xlsx'},'layout':{'path':str(pdf),'url':f'https://www.dol.gov/{name}-{fy}.pdf'}})
    f=DATA/f'{name}.json';f.write_text(json.dumps({'schema_version':1,'sources':sources}));return f
try:
    run('query','--company','Acme, Inc.',ok=False)
    base25=[row('A','Certified','2024-01-01','2025-01-01'),row('B','Denied','2024-01-01','2025-01-11'),row('C','Withdrawn','bad','2025-01-01'),row('D','Certified - Expired','2025-02-01','2025-01-01'),row('E','Certified',company='Exact LLC',trade='Trade Brand'),row('M','Certified',company='Multiple Inc',city='Seattle'),row('N','Certified',company='Multiple Inc',city='Boston'),row('W','Withdrawn',company='WithdrawnOnly LLC'),row('I','Certified',company='EXACT, LLC.',city='SEATTLE')]
    base26=[row('A','Denied','2024-01-01','2026-01-01'),row('F','Certified','2025-01-01','2026-01-01'),row('G','Certified','2025-01-01','2026-01-11'),row('H','Certified','2025-01-01','2026-01-21')]
    good=manifest(base25,base26)
    run('import','--manifest',str(good))
    current=BOX/'.local/perm-history/current.json'; before=current.read_bytes()
    q=run('query','--company','Acme, Inc.')
    check('latest correction only counted once',q['total_disclosed_cases']==7)
    check('all four statuses',q['status_counts']=={'Certified':3,'Certified-Expired':1,'Denied':2,'Withdrawn':1})
    check('rate numerator denominator',q['historical_certification_share']=={'numerator':4,'denominator':6,'value':4/6})
    check('durations sample and exclusions',q['processing_days']['Certified']=={'n':3,'excluded':0,'median':375,'p25':370.0,'p75':380.0} and q['processing_days']['Certified-Expired']['excluded']==1 and q['processing_days']['Withdrawn']['excluded']==1)
    check('annual revised attribution',q['years']['2025']['disclosed_cases']==3 and q['years']['2026']['disclosed_cases']==4)
    check('raw locators available',all('row' in x and 'sheet' in x for x in q['cases']))
    check('zero denominator remains unavailable',run('query','--company','WithdrawnOnly LLC')['historical_certification_share']=={'numerator':0,'denominator':0,'value':None})
    check('trade-only collision cannot attribute unrelated legal entity',run('query','--company','Trade Brand')['match_status']=='ambiguous')
    check('unconfirmed trade has no totals', 'total_disclosed_cases' not in run('query','--company','Trade Brand'))
    check('case punctuation and city case variation is one legal identity',run('query','--company','Exact LLC')['match_status']=='exact')
    check('raw legal spelling variants preserved',len(run('query','--company','Exact LLC')['matched_employers'][0]['raw_variants'])==2)
    check('suffix only suggestion',run('query','--company','Acme')['match_status']=='not_found')
    check('no substring guess',run('query','--company','Acm')['match_status']=='not_found')
    check('different employer cities ambiguous',run('query','--company','Multiple Inc')['match_status']=='ambiguous')
    check('query read-only',current.read_bytes()==before)
    for name,rows,headers in [('status',[row('Z','Unknown')],HEAD),('conflict',[row('Z'),row('Z',decision='2025-01-02'),row('Z','Denied')],HEAD),('header',[row('Z')],HEAD[1:]),('empty',[],HEAD)]:
        bad=manifest(rows,base26,name=name,headers=headers);run('import','--manifest',str(bad),ok=False);check(name+' failure preserves pointer',current.read_bytes()==before)
    bad=json.loads(good.read_text());bad['sources'].append(bad['sources'][0]);f=DATA/'duplicate.json';f.write_text(json.dumps(bad));run('import','--manifest',str(f),ok=False)
    for name,body,url in [('html',b'<html>Error</html>','https://www.dol.gov/error.xlsx'),('truncated',b'PK\x03\x04broken','https://www.dol.gov/broken.xlsx'),('unsafe',b'PK\x03\x04broken','https://example.com/unsafe.xlsx')]:
        bad=json.loads(good.read_text());f=DATA/(name+'.xlsx');f.write_bytes(body);bad['sources'][0]['xlsx']={'path':str(f),'url':url};m=DATA/(name+'.json');m.write_text(json.dumps(bad));run('import','--manifest',str(m),ok=False);check(name+' preserves current',current.read_bytes()==before)
    lock=BOX/'.local/perm-history/write.lock';lock.write_text('fixture writer');run('import','--manifest',str(good),ok=False);lock.unlink()
    symlink=DATA/'symlink.xlsx';symlink.symlink_to(Path(json.loads(good.read_text())['sources'][0]['xlsx']['path']));bad=json.loads(good.read_text());bad['sources'][0]['xlsx']['path']=str(symlink);f=DATA/'symlink.json';f.write_text(json.dumps(bad));run('import','--manifest',str(f),ok=False)
    evidence=BOX/'scored.json';evidence.write_text(json.dumps({'company':'Acme, Inc.','score':80}))
    selection=DATA/'selection.json';selection.write_text(json.dumps({'companies':[{'company':'Acme, Inc.','scored_evidence':[{'path':str(evidence)}]}]}))
    r=run('preview','--companies',str(selection),'--id','sample');check('preview markdown exists',Path(r['directory'],'preview.md').exists())
    aliasroot=BOX/'.local/perm-history'
    proof=aliasroot/'evidence/identity.txt';proof.parent.mkdir();proof.write_text('Trade Brand is the trading name of Exact LLC in Seattle, WA.')
    alias={'id':'trade-brand','source_company':'Trade Brand','status':'verified','relationship_type':'trade_name','source_evidence_ids':['identity'],'scope':{'type':'posting','postings':[{'posting_key':'fixture:brand:1','posting_url':'https://example.com/jobs/1'}]},'targets':[{'legal_name':'Exact LLC','locations':[{'city':'Seattle','state':'WA'}],'evidence_ids':['identity']}],'evidence':[{'id':'identity','url':'https://example.com/jobs/1','path':'evidence/identity.txt','quote':'Trade Brand is the trading name of Exact LLC','checked_at':'2026-10-17T09:00:00Z'}]}
    registry=aliasroot/'employer-aliases.json'
    def put_alias(value):registry.write_text(json.dumps({'schema_version':1,'aliases':value}))
    bundle=aliasroot/'proposed.json';bundle.write_text(json.dumps({'schema_version':1,'aliases':[alias]}))
    run('aliases-import','--file',str(bundle));installed=registry.read_bytes()
    bundle.write_text(json.dumps({'schema_version':1,'aliases':[dict(alias,targets=[])]}));run('aliases-import','--file',str(bundle),ok=False);check('failed alias import preserves existing registry',registry.read_bytes()==installed)
    missing=run('query','--company','Trade Brand');check('scoped alias names-only has no trusted totals',missing['match_status']=='missing_context' and 'total_disclosed_cases' not in missing)
    ctx=['--posting-key','fixture:brand:1','--posting-url','https://example.com/jobs/1']
    q=run('query','--company','Trade Brand',*ctx);check('verified alias scoped offline counts',q['match_status']=='verified_alias' and q['total_disclosed_cases']==2 and q['company']=='Trade Brand' and q['matched_employers'][0]['name'] in ('Exact LLC','EXACT, LLC.'))
    check('wrong job context never inherits brand mapping',run('query','--company','Trade Brand','--posting-key','fixture:brand:2','--posting-url','https://example.com/jobs/2')['match_status']=='context_mismatch')
    for name,change in [('duplicate',lambda a:[a,a]),('empty targets',lambda a:[dict(a,targets=[])]),('unapproved',lambda a:[dict(a,status='auto')]),('no locations',lambda a:[dict(a,targets=[dict(a['targets'][0],locations=[])])]),('unknown location',lambda a:[dict(a,targets=[dict(a['targets'][0],locations=[{'city':'Elsewhere','state':'WA'}])])]),('evidence path escape',lambda a:[dict(a,evidence=[dict(a['evidence'][0],path='../outside')])]),('missing evidence',lambda a:[dict(a,evidence=[dict(a['evidence'][0],path='missing')])]),('quote absent',lambda a:[dict(a,evidence=[dict(a['evidence'][0],quote='invented quote')])]),('missing source JD',lambda a:[dict(a,source_evidence_ids=[])]),('wrong scoped URL',lambda a:[dict(a,scope={'type':'posting','postings':[{'posting_key':'fixture:brand:1','posting_url':'https://example.com/jobs/other'}]})]),('invalid company scope',lambda a:[dict(a,scope={'type':'company','official_identity_url':'https://unverified.example/legal'})]),('dangling evidence',lambda a:[dict(a,targets=[dict(a['targets'][0],evidence_ids=['absent'])])])]:
        put_alias(change(json.loads(json.dumps(alias))));run('query','--company','Acme, Inc.',ok=False);check('bad alias '+name+' preserves current',current.read_bytes()==before)
    put_alias([alias])
    named=DATA/'alias-selection.json';named.write_text(json.dumps({'companies':[{'company':'Trade Brand','scored_evidence':[{'path':str(evidence),'posting_key':ctx[1],'posting_url':ctx[3]}]}]}))
    r=run('preview','--companies',str(named),'--id','alias-sample');frozen=Path(r['directory']);frozenfiles={str(f.relative_to(frozen)):f.read_bytes() for f in frozen.rglob('*') if f.is_file()}
    payload=json.loads((frozen/'preview.json').read_text());check('preview consumes scored posting context',payload['companies'][0]['match_status']=='verified_alias')
    check('preview freezes alias registry and evidence', (frozen/'employer-aliases.json').exists() and (frozen/'alias-evidence').is_dir() and json.loads((frozen/'manifest.json').read_text())['alias_snapshot']['path']=='employer-aliases.json')
    check('preview contains no checksum fields',all('sha256' not in f.read_text().lower() and 'sha-256' not in f.read_text().lower() for f in frozen.rglob('*') if f.suffix in ('.json','.md','.txt')))
    proof.write_text(proof.read_text()+' Additional context.');check('evidence remains usable when quote is retained',run('query','--company','Trade Brand',*ctx)['match_status']=='verified_alias')
    multi=json.loads(json.dumps(alias));multi['targets'].append({'legal_name':'Acme, Inc.','locations':[{'city':'Seattle','state':'WA'}],'evidence_ids':['identity']});put_alias([multi]);q=run('query','--company','Trade Brand',*ctx);check('multiple entities remain separate without group totals',len(q['entities'])==2 and 'total_disclosed_cases' not in q)
    run('preview','--companies',str(named),'--id','multi-entity-sample');multi_json=json.loads((aliasroot/'previews/multi-entity-sample/preview.json').read_text());check('multi entity preview renders without aggregate',len(multi_json['companies'][0]['entities'])==2 and 'total_disclosed_cases' not in multi_json['companies'][0])
    company_alias=dict(alias,scope={'type':'company','official_identity_url':'https://example.com/jobs/1'});put_alias([company_alias]);check('explicit company identity scope works names only',run('query','--company','Trade Brand')['match_status']=='verified_alias')
    absent=json.loads(json.dumps(alias));absent['targets'][0]['legal_name']='Verified No Records LLC';put_alias([absent]);q=run('query','--company','Trade Brand',*ctx);check('verified identity absent from disclosures is not zero applications',q['match_status']=='not_found' and q['alias_verification']=='verified' and 'total_disclosed_cases' not in q)
    history=dict(absent,relationship_type='company_history_reference',scope=company_alias['scope']);history['targets'][0]['locations']=[];put_alias([history]);q=run('query','--company','Trade Brand');check('company history without disclosed records needs no invented address',q['match_status']=='not_found' and q['alias_verification']=='verified' and q['entities'][0]['locations']==[] and 'total_disclosed_cases' not in q)
    installed=registry.read_bytes()
    for label,value in [('existing legal name without locations',dict(history,targets=[dict(history['targets'][0],legal_name='Exact LLC')])),('posting scoped company history',dict(history,scope=alias['scope'])),('legacy alias without locations',dict(history,relationship_type='trade_name'))]:
        bundle.write_text(json.dumps({'schema_version':1,'aliases':[value]}));run('aliases-import','--file',str(bundle),ok=False);check(label+' rejects import without replacing registry',registry.read_bytes()==installed)
    unresolved=dict(alias,status='unresolved',targets=[],reason='No confirmed legal identity');put_alias([unresolved]);q=run('query','--company','Trade Brand',*ctx);check('unresolved evidence cannot produce statistics',q['match_status']=='unresolved' and 'total_disclosed_cases' not in q)
    put_alias([alias]);evidence_link=proof.with_name('link.txt');evidence_link.symlink_to(proof);attack_alias=json.loads(json.dumps(alias));attack_alias['evidence'][0]['path']='evidence/link.txt';put_alias([attack_alias]);run('query','--company','Acme, Inc.',ok=False)
    put_alias([alias]);proof.write_text('changed evidence');run('query','--company','Acme, Inc.',ok=False)
    check('registry edits do not rewrite frozen preview',all((frozen/name).read_bytes()==value for name,value in frozenfiles.items()))
    registry.unlink()
    snapshot=run('scan-snapshot')
    names=['Alpha Review','Beta Review','Gamma Review','Delta Review','Epsilon Review']
    proof.write_text('\n'.join(name+' is operated by Exact LLC.' for name in names))
    reviewed=[]
    for index,name in enumerate(names):
        item=json.loads(json.dumps(company_alias));item.update(id='review-'+str(index),source_company=name,relationship_type='company_history_reference')
        item['evidence'][0]['quote']=name+' is operated by Exact LLC.';reviewed.append(item)
    bundle.write_text(json.dumps({'schema_version':1,'aliases':reviewed}));run('aliases-import','--file',str(bundle))
    records=[{'posting_key':'fixture:review:'+str(i),'posting_url':'https://example.com/review/'+str(i),'company':name,'scored':True} for i,name in enumerate(names)]
    payload={'snapshot':snapshot,'records':records,'decisions':[{'company':name,'outcome':'verified','note':'Synthetic official identity evidence.'} for name in names]}
    frozen_review=run('company-review-freeze',payload=payload,seed=1)
    for seed in [2,3,4]:
        checked=run('company-review-check',payload={**payload,'review':frozen_review},seed=seed)
        check('multiple verified mappings survive a separate hash-seeded process '+str(seed),len(checked['postings'])==len(names))
    registry.unlink()
    attack=BOX/'.local/perm-history/previews/symlink-preview';attack.mkdir();(attack/'preview.md').symlink_to(BOX/'should-not-exist.md');run('preview','--companies',str(selection),'--id','symlink-preview',ok=False);check('dangling preview symlink does not write outside root',not (BOX/'should-not-exist.md').exists())
    evidence.unlink();run('preview','--companies',str(selection),'--id','bad',ok=False)
    pointer=json.loads(current.read_text());version=BOX/'.local/perm-history'/pointer['path'];layout=version/'layouts/FY2025_Q4.pdf';layout.chmod(0o600);original=layout.read_bytes();layout.write_bytes(b'not a PDF');run('query','--company','Acme, Inc.',ok=False);layout.write_bytes(original)
    pointer=json.loads(current.read_text());db=BOX/'.local/perm-history'/pointer['path']/'cases.sqlite';db.chmod(0o600);db.write_bytes(b'not a SQLite database');run('query','--company','Acme, Inc.',ok=False)
    save();print(json.dumps({'status':'COMPLETE','artifact':str(OUT),'assertions':len(assertions)}))
except Exception:
    save();raise
