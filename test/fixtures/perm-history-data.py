"""Fictional local disclosure index for Daily Scan E2E; never a real import receipt."""
import importlib.util,json,sqlite3,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('perm',root/'src/perm-history.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
d=p.DATA;version=d/'versions/fixture-v1';version.mkdir(parents=True)
def write(file,v):file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(v,indent=2)+'\n')
sources=[]
for fy,q in [(2025,4),(2026,3)]:
 x=f'FY{fy}.xlsx';pdf=f'FY{fy}.pdf'
 with zipfile.ZipFile(version/x,'w') as z:z.writestr('fixture.txt','Fictional raw locator only')
 (version/pdf).write_bytes(b'%PDF-1.4\nfixture\n%%EOF')
 sources.append({'fiscal_year':fy,'quarter':q,'coverage_start':f'{fy-1}-10-01','coverage_end':f'{fy}-09-30' if q==4 else f'{fy}-06-30','xlsx':{'path':x,'url':f'https://www.dol.gov/fixture-{fy}.xlsx'},'layout':{'path':pdf,'url':f'https://www.dol.gov/fixture-{fy}.pdf'}})
write(version/'manifest.json',{'schema_version':1,'revision':'fixture-v1','sources':sources,'database':{'path':'cases.sqlite'}})
write(version/'import-audit.json',{'status':'COMPLETE','note':'Fictional fixture, not official import evidence'})
write(d/'current.json',{'schema_version':1,'revision':'fixture-v1','path':'versions/fixture-v1'})
db=sqlite3.connect(version/'cases.sqlite');db.execute('CREATE TABLE cases(case_number TEXT PRIMARY KEY,employer_norm TEXT,trade_norm TEXT,decision TEXT,release_order INTEGER,payload TEXT)')
for i,(company,city,status,fy) in enumerate([('Exact Labs Inc.','Seattle','Certified',2025),('Exact Labs Inc.','Seattle','Denied',2025),('Exact Labs Inc.','Seattle','Withdrawn',2026),('Parent Labs Inc.','Seattle','Certified',2025),('Parent Labs Inc.','Seattle','Certified-Expired',2026),('Collision Inc.','Seattle','Certified',2025),('Collision Inc.','Boston','Certified',2025)]):
 r={k:'' for k in p.FIELDS};r.update(case_number=f'F-{i}',status=status,employer=company,employer_city=city,employer_state='WA',received=f'{fy-1}-01-01',decision=f'{fy}-01-01',decision_fiscal_year=fy,processing_days=366,source_file=f'FY{fy}.xlsx',source_url=f'https://www.dol.gov/fixture-{fy}.xlsx',sheet='PERM',row=i+2,job_title='Software Engineer',soc_code='15-1252',worksite_city='Seattle',worksite_state='WA',law_firm='Fictional Law')
 db.execute('INSERT INTO cases VALUES (?,?,?,?,?,?)',(r['case_number'],p.norm(company),'',r['decision'],fy,json.dumps(r)))
db.commit();db.close()
aliases=[]
for brand,legal,scope in [('Brand Labs','Parent Labs Inc.',{'type':'company','official_identity_url':'https://example.invalid/identity'}),('Scoped Brand','Parent Labs Inc.',{'type':'posting','postings':[{'posting_key':'linkedin:linkedin.com:89500003','posting_url':'https://www.linkedin.com/jobs/view/89500003'}]}),('Absent Brand','Absent Legal Inc.',{'type':'company','official_identity_url':'https://example.invalid/identity'})]:
 evidence=[{'id':'identity','url':'https://example.invalid/identity','path':f'evidence/{brand}.txt','quote':f'{brand} is {legal}','checked_at':'2026-10-17T00:00:00Z'},{'id':'jd','url':'https://www.linkedin.com/jobs/view/89500003','path':f'evidence/{brand}-jd.txt','quote':f'Company: {brand}','checked_at':'2026-10-17T00:00:00Z'}]
 for e in evidence:(d/e['path']).parent.mkdir(parents=True,exist_ok=True);(d/e['path']).write_text(e['quote']+'\n')
 aliases.append({'id':brand,'source_company':brand,'status':'verified','relationship_type':'company_history_reference' if brand=='Brand Labs' else 'verified_brand','source_evidence_ids':['identity'] if brand=='Brand Labs' else ['jd'],'scope':scope,'reason':'Only the listed historical entity is verified; other affiliates are excluded.','targets':[{'legal_name':legal,'locations':[{'city':'Seattle','state':'WA'}],'evidence_ids':['identity']}],'evidence':evidence})
write(d/'employer-aliases.json',{'schema_version':1,'aliases':aliases})
