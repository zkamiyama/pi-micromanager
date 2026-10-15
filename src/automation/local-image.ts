/** Bounded image headers, not an image decoder or proof of QC capture.
 * The encoded limit leaves headroom inside PI WEB's 256 KiB JSON boundary. */
export const LOCAL_IMAGE_MAX_BYTES = 180 * 1024;
export const LOCAL_IMAGE_MAX_BASE64 = 4 * Math.ceil(LOCAL_IMAGE_MAX_BYTES / 3);
const dimensions = (width:number,height:number):void => {
  if(width<1||height<1||width>4096||height>4096||width*height>16*1024*1024)
    throw new Error("Unsupported image frame dimensions");
};
export function localImageMime(bytes:Buffer):"image/png"|"image/jpeg" {
  if(bytes.length<16||bytes.length>LOCAL_IMAGE_MAX_BYTES)
    throw new Error("Local image exceeds the bounded 180 KiB input limit");
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    if(bytes.length<33||bytes.readUInt32BE(8)!==13||bytes.toString("ascii",12,16)!=="IHDR")
      throw new Error("Invalid PNG header");
    dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20));
    const depths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if(!depths[bytes[25]!]?.includes(bytes[24]!)||bytes[26]!==0||bytes[27]!==0||bytes[28]!>1)
      throw new Error("Unsupported PNG header encoding");
    let idat=false,ended=false;
    for(let pos=33;pos<bytes.length;){
      if(pos+12>bytes.length)throw new Error("Truncated PNG chunk");
      const length=bytes.readUInt32BE(pos),kind=bytes.toString("ascii",pos+4,pos+8);
      if(length>bytes.length-pos-12)throw new Error("Truncated PNG chunk");
      if(["IHDR","acTL","fcTL","fdAT"].includes(kind))throw new Error("Multiple or animated PNG frames are unsupported");
      if(kind==="IDAT")idat=true;
      if(kind==="IEND"){
        if(length!==0||!idat)throw new Error("Invalid PNG end");
        ended=true;break;
      }
      pos+=length+12;
    }
    if(!ended)throw new Error("Incomplete PNG image");
    return "image/png";
  }
  if(bytes[0]!==255||bytes[1]!==216)throw new Error("Only bounded PNG/JPEG images are accepted");
  let pos=2,frame=false,scan=false,inScan=false;
  // Walk all segments, including markers between progressive scans. A second
  // frame or DNL must not change dimensions after the first trusted header.
  while(pos<bytes.length){
    if(inScan){
      while(pos<bytes.length&&bytes[pos]!==255)pos++;
      if(pos>=bytes.length)break;
    }
    if(bytes[pos++]!==255)throw new Error("Invalid JPEG marker");
    while(bytes[pos]===255)pos++;
    const marker=bytes[pos++];
    if(marker===undefined)break;
    if(inScan&&(marker===0||marker>=0xd0&&marker<=0xd7))continue;
    if(marker===0xd9){
      if(!frame||!scan||pos!==bytes.length)throw new Error("Invalid JPEG end/frame");
      return "image/jpeg";
    }
    inScan=false;
    if(marker===0xd8||marker===0xdc||marker===0xde||marker===0xdf||marker===0||marker===1||marker>=0xd0&&marker<=0xd7)
      throw new Error("Unsupported JPEG frame/marker");
    if(pos+2>bytes.length)throw new Error("Truncated JPEG segment");
    const size=bytes.readUInt16BE(pos),end=pos+size;
    if(size<2||end>bytes.length)throw new Error("Invalid JPEG segment length");
    if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)){
      if(frame||![0xc0,0xc2].includes(marker)||size<8||bytes[pos+2]!==8)
        throw new Error("Unsupported JPEG frame");
      const components=bytes[pos+7]!;
      if(![1,3,4].includes(components)||size!==8+3*components)throw new Error("Invalid JPEG frame components");
      dimensions(bytes.readUInt16BE(pos+5),bytes.readUInt16BE(pos+3));
      frame=true;
    }
    if(marker===0xda){
      if(!frame||size<6||size!==6+2*bytes[pos+2]!)throw new Error("JPEG scan has no supported frame");
      scan=true;inScan=true;
    }
    pos=end;
  }
  throw new Error("Incomplete JPEG image/frame");
}
