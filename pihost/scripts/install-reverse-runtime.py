#!/usr/bin/env python3
"""Pinned Linux x64 analysis tools; release archives verified against publisher hashes."""
import argparse, hashlib, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, urllib.request, zipfile
HERE=pathlib.Path(__file__).resolve().parent.parent
ROOT=pathlib.Path(os.environ.get('WORMHOLE_TOOLS_DIR','/opt/wormhole/tools'))
ASSETS=[
 ('jdk','https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz','d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c','jdk/bin/java'),
 ('ghidra','https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip','ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db','ghidra/support/analyzeHeadless'),
 ('extras/apktool_3.0.3.jar','https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar','dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423','extras/apktool_3.0.3.jar'),
 ('extras/jadx-headless-mcp-0.7.1-all.jar','https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar','6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75','extras/jadx-headless-mcp-0.7.1-all.jar')]
def run(*args):subprocess.run(args,check=True)
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def extract_tar(archive,dest):
 # Debian Bookworm's Python 3.11 predates the extraction-filter API.
 if hasattr(tarfile,'data_filter'):
  archive.extractall(dest,filter='data');return
 root=dest.resolve()
 for member in archive.getmembers():
  target=(root/member.name).resolve()
  if not target.is_relative_to(root) or member.isdev() or member.isfifo():raise RuntimeError('Unsafe archive entry: '+member.name)
  if member.issym() or member.islnk():
   link=(target.parent/member.linkname if member.issym() else root/member.linkname).resolve()
   if not link.is_relative_to(root):raise RuntimeError('Unsafe archive link: '+member.name)
 archive.extractall(dest)
def asset(name,url,digest,entry):
 if (ROOT/entry).exists():return
 print('Installing '+name,flush=True)
 cache=ROOT/'downloads';cache.mkdir(exist_ok=True)
 source=cache/(digest+('.zip' if url.endswith('.zip') else '.tgz' if url.endswith('.tar.gz') else '.jar'))
 if not source.exists() or sha(source)!=digest:
  part=source.with_suffix('.part')
  try:
   with urllib.request.urlopen(os.environ.get('WORMHOLE_REVERSE_DOWNLOAD_PREFIX','')+url,timeout=120) as response,part.open('wb') as out:shutil.copyfileobj(response,out,1024*1024)
   if sha(part)!=digest:raise RuntimeError('Publisher SHA-256 mismatch: '+name)
   part.replace(source)
  finally:part.unlink(missing_ok=True)
 target=ROOT/name;target.parent.mkdir(parents=True,exist_ok=True)
 if name.startswith('extras/'):shutil.copyfile(source,target);return
 with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
  dest=pathlib.Path(temporary)
  if url.endswith('.zip'):
   with zipfile.ZipFile(source) as archive:archive.extractall(dest)
  else:
   with tarfile.open(source) as archive:extract_tar(archive,dest)
  entries=list(dest.iterdir())
  if len(entries)!=1 or not entries[0].is_dir():raise RuntimeError('Unexpected distribution layout')
  entries[0].rename(target)
 if name=='ghidra':
  for p in target.rglob('*'):
   if p.is_file() and (p.suffix=='.sh' or p.name in ['analyzeHeadless','ghidraRun','decompile','sleigh','server','bsim'] or 'linux_x86_64' in p.parts):p.chmod(p.stat().st_mode|0o111)
def main():
 parser=argparse.ArgumentParser();parser.add_argument("--components",default="rea,js,native,android,protocol");args=parser.parse_args()
 selected=set(args.components.split(","));unknown=selected-{"rea","js","native","android","protocol","frida"}
 if unknown:raise SystemExit("Unknown components: "+",".join(sorted(unknown)))
 if 'frida' in selected:selected.add('rea')
 if sys.platform!='linux' or os.uname().machine!='x86_64':raise SystemExit('Requires Linux x64')
 if os.geteuid()!=0:raise SystemExit('Install as root; task sandbox requires root-owned read-only tools')
 for cmd in ['node','npm','python3','gcc','openssl']:
  if not shutil.which(cmd):raise SystemExit('Missing prerequisite: '+cmd)
 if 'rea' in selected and not shutil.which('ps'):raise SystemExit('REA requires procps (ps). Install it before running this installer.')
 ROOT.mkdir(parents=True,exist_ok=True);ROOT.chmod(0o755)
 for item in ASSETS:
  name=item[0]
  if (name=="jdk" and selected & {"native","android"}) or (name=="ghidra" and "native" in selected) or (name.startswith("extras/") and "android" in selected):asset(*item)
 for name in sorted(selected & {'rea','js'}):
  dest=ROOT/name;dest.mkdir(exist_ok=True)
  for f in ['package.json','package-lock.json']:shutil.copyfile(HERE/'runtime/reverse'/name/f,dest/f)
  run('npm','ci','--prefix',str(dest),'--no-audit','--no-fund',*(['--omit=optional'] if name=='rea' and 'frida' not in selected else []),'--registry',os.environ.get('WORMHOLE_NPM_REGISTRY','https://registry.npmjs.org'))
 for name,packages in [('proto-py',['dpkt==1.9.8','construct==2.10.70']),('rea-py',['pwntools==4.15.0','pyelftools==0.33','unicorn==2.1.2'])]:
  if (name=='proto-py' and 'protocol' not in selected) or (name=='rea-py' and 'native' not in selected):continue
  if not (ROOT/name/'bin/python').exists():run('python3','-m','venv',str(ROOT/name))
  run(str(ROOT/name/'bin/pip'),'install',*packages)
 proto=ROOT/'proto-re'
 if 'protocol' in selected:
  proto.mkdir(exist_ok=True)
  for f in ['proto_re.py','selftest.py']:shutil.copyfile(HERE.parent/'extensions/skills/wormhole-proto-reverse/scripts'/f,proto/f)
 binary=ROOT/'bin';binary.mkdir(exist_ok=True)
 for name in (['webcrack','js-beautify','terser','wakaru'] if 'js' in selected else []):
  link=binary/name;link.unlink(missing_ok=True);link.symlink_to(ROOT/'js/node_modules/.bin'/name)
 for name,cmd in [('proto-re',f'{ROOT}/proto-py/bin/python {proto}/proto_re.py'),('apktool',f'{ROOT}/jdk/bin/java -jar {ROOT}/extras/apktool_3.0.3.jar')]:
  if (name=='proto-re' and 'protocol' not in selected) or (name=='apktool' and 'android' not in selected):continue
  script=binary/name;script.write_text('#!/bin/sh\nexec '+cmd+' "$@"\n');script.chmod(0o755)
 if selected & {'native','android'}:run(str(ROOT/'jdk/bin/java'),'-version')
 if 'protocol' in selected:run(str(ROOT/'proto-py/bin/python'),str(proto/'selftest.py'))
 print('Installed components: '+','.join(sorted(selected))+'. Enable and authorize them explicitly in WORMHOLE.')
if __name__=='__main__':main()
