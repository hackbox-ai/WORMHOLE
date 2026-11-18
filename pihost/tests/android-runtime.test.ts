import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {connectMcp} from '../src/domains/mcp/client.ts';

test('installed Android toolchain: actual JADX MCP decompilation and Apktool APK roundtrip',{skip:process.env.WORMHOLE_REVERSE_INTEGRATION!=='1',timeout:120000},async t=>{
 const tools=process.env.WORMHOLE_TOOLS_DIR??'/opt/wormhole/tools',dir=await mkdtemp('/tmp/wormhole-android-');
 const java=tools+'/jdk/bin/java',apktool=tools+'/extras/apktool_3.0.3.jar';
 try{
  await t.test('JADX loads a compiled local JAR, lists classes and recovers arithmetic',async()=>{
   await writeFile(dir+'/Proof.java','public class Proof { public static int total(int value) { return value * 7 + 11; } }');
   execFileSync(tools+'/jdk/bin/javac',['--release','8',dir+'/Proof.java']);
   execFileSync(tools+'/jdk/bin/jar',['cf',dir+'/proof.jar','-C',dir,'Proof.class']);
   const c=await connectMcp({name:'android-fixture',transport:'stdio',command:java,args:['-jar',tools+'/extras/jadx-headless-mcp-0.7.1-all.jar','--threads','2']},undefined,dir);
   try{
    const call=async(name:string,args:Record<string,unknown>)=>{const result=await c.client.callTool({name,arguments:args},undefined,{timeout:90000});assert.ok(!result.isError,JSON.stringify(result));return JSON.stringify(result);};
    await call('load_apk',{path:dir+'/proof.jar'});
    assert.match(await call('list_classes',{}),/Proof/);
    const source=await call('get_class_source',{class_name:'Proof'});assert.match(source,/total/);assert.match(source,/\* 7|7 \*/);assert.match(source,/\+ 11/);
    await call('unload_apk',{});
   }finally{await c.close();}
  });
  await t.test('Apktool builds and decodes a controlled resource-only APK',async()=>{
   const source=dir+'/app';await mkdir(source+'/res/values',{recursive:true});
   await writeFile(source+'/apktool.yml','version: 3.0.3\napkFileName: fixture.apk\nusesFramework:\n  ids:\n  - 1\nsdkInfo:\n  minSdkVersion: 23\n  targetSdkVersion: 28\npackageInfo:\n  forcedPackageId: 127\nversionInfo:\n  versionCode: 1\n  versionName: "1.0"\n');
   await writeFile(source+'/AndroidManifest.xml','<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.wormhole.fixture"><uses-permission android:name="android.permission.INTERNET"/><application android:hasCode="false" android:label="WORMHOLE fixture"/></manifest>');
   await writeFile(source+'/res/values/strings.xml','<resources><string name="proof">WORMHOLE_ANDROID_PROOF</string></resources>');
   execFileSync(java,['-jar',apktool,'b',source,'-o',dir+'/fixture.apk'],{timeout:60000,env:{...process.env,HOME:dir}});
   execFileSync(java,['-jar',apktool,'d','-s',dir+'/fixture.apk','-o',dir+'/decoded'],{timeout:60000,env:{...process.env,HOME:dir}});
   assert.match(await readFile(dir+'/decoded/AndroidManifest.xml','utf8'),/com.wormhole.fixture/);
   assert.match(await readFile(dir+'/decoded/res/values/strings.xml','utf8'),/WORMHOLE_ANDROID_PROOF/);
  });
 }finally{await rm(dir,{recursive:true,force:true});}
});
