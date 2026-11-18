/** strings.ToValidUTF8 / bytes.ToValidUTF8: one replacement per invalid run,
 * rather than the WHATWG decoder's one replacement per invalid byte. */
export function goUTF8(b:Buffer):string{
 let out='',validStart=0,i=0,invalid=false;
 while(i<b.length){const a=b[i]!,size=a<0x80?1:a>=0xc2&&a<=0xdf?2:a>=0xe0&&a<=0xef?3:a>=0xf0&&a<=0xf4?4:0;
  const c=b[i+1]??0,ok=!!size&&i+size<=b.length&&(size<2||c>=0x80&&c<=0xbf)&&(size<3||b[i+2]!>=0x80&&b[i+2]!<=0xbf)&&(size<4||b[i+3]!>=0x80&&b[i+3]!<=0xbf)&&!(a===0xe0&&c<0xa0||a===0xed&&c>=0xa0||a===0xf0&&c<0x90||a===0xf4&&c>=0x90);
  if(ok){if(invalid){out+='�';validStart=i;invalid=false;}i+=size;}
  else{if(!invalid){out+=b.subarray(validStart,i).toString('utf8');invalid=true;}i++;}
 }
 return out+(invalid?'�':b.subarray(validStart).toString('utf8'));
}
