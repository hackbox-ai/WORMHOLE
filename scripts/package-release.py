#!/usr/bin/env python3
"""Create a source release with a per-file manifest; optionally export a Docker image."""
import argparse,hashlib,json,pathlib,subprocess,zipfile

ROOT=pathlib.Path(__file__).resolve().parent.parent
EXCLUDED={'artifacts','node_modules','.git','.next','out','__pycache__','.playwright-cli','.playwright-mcp','.vscode','.idea'}
EXCLUDED_FILES={'SOURCE_SNAPSHOT.json','config.local.json','config.test.json','jwt.key','next-env.d.ts','.DS_Store','Thumbs.db'}

def digest(file):
 with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def included(file):
 relative=file.relative_to(ROOT)
 if any(part in EXCLUDED for part in relative.parts):return False
 if any(part=='data' for part in relative.parts):return False
 if relative.as_posix().startswith('pihost/vendor/fingerprint/'):return False
 if file.name in EXCLUDED_FILES or file.suffix in {'.log','.pyc','.tsbuildinfo'}:return False
 if file.name.startswith('.env') and file.name!='.env.example':return False
 return True

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--image',help='Also save this locally built Docker image');parser.add_argument('--include-image',action='append',default=[],help='Additional images for the same offline archive');args=parser.parse_args()
 version=json.loads((ROOT/'pihost/package.json').read_text(encoding='utf8'))['version']
 folder='WORMHOLE-'+version;output=ROOT/'artifacts/releases';output.mkdir(parents=True,exist_ok=True)
 files=sorted((file for file in ROOT.rglob('*') if file.is_file() and included(file)),key=lambda file:file.relative_to(ROOT).as_posix())
 manifest=[];archive=output/(folder+'-source.zip')
 with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as bundle:
  def add(name,data,executable=False):
   entry=zipfile.ZipInfo(folder+'/'+name,date_time=(2026,11,14,0,0,0));entry.create_system=3;entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=(0o100755 if executable else 0o100644)<<16;bundle.writestr(entry,data)
  for file in files:
   if file.is_symlink():raise RuntimeError('Release must not contain symlinks: '+str(file))
   name=file.relative_to(ROOT).as_posix();data=file.read_bytes();manifest.append(hashlib.sha256(data).hexdigest()+'  '+name)
   add(name,data,file.suffix=='.sh' or file.name=='codec-linux-amd64')
  add('MANIFEST.sha256',('\n'.join(manifest)+'\n').encode())
 artifacts=[archive];image=None
 if args.image:
  image=json.loads(subprocess.check_output(['docker','image','inspect',args.image],text=True))[0]
  tar=output/(folder+'-linux-amd64.docker.tar');subprocess.run(['docker','image','save',args.image,*args.include_image,'--output',str(tar)],check=True);artifacts.append(tar)
 metadata={'version':version,'sourceFiles':len(files),'license':'not selected by maintainer','artifacts':[{'file':file.name,'bytes':file.stat().st_size,'sha256':digest(file)} for file in artifacts]}
 if image:
  metadata['docker']={'tag':args.image,'id':image['Id'],'os':image['Os'],'architecture':image['Architecture']}
  metadata['includedImages']=[{'tag':tag,'id':json.loads(subprocess.check_output(['docker','image','inspect',tag],text=True))[0]['Id']} for tag in [args.image,*args.include_image]]
 (output/'release.json').write_text(json.dumps(metadata,indent=2,ensure_ascii=False)+'\n',encoding='utf8')
 (output/'SHA256SUMS').write_text(''.join(item['sha256']+'  '+item['file']+'\n' for item in metadata['artifacts']),encoding='utf8')
 print(json.dumps(metadata,ensure_ascii=False))

if __name__=='__main__':main()
